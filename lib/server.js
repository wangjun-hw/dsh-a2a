/**
 * A2A HTTP server routes and task runtime.
 *
 * One DSH Agent (and therefore one persisted Session) is created lazily per
 * A2A `contextId`. Each A2A task is one DSH turn on that Agent; committed
 * assistant messages become A2A artifact chunks, and the turn ending decides
 * the task state.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import {
  A2aError,
  LEGACY_METHODS,
  METHODS,
  TASK_STATE,
  TERMINAL_STATES,
  agentMessage,
  assistantText,
  errors,
  normalizeState,
  parseMessage,
  rpcError,
  rpcResult,
  serializeArtifactUpdate,
  serializeStatusUpdate,
  serializeTask,
  timestamp,
} from './protocol.js'

const A2A_SESSION_GUIDANCE =
  'An external agent is calling this Session over the A2A protocol. '
  + 'Your reply text is returned to that caller as the task artifact. '
  + 'Complete the request within this turn: do not ask the caller questions and do not wait for interactive input.'

const DEFAULT_CARD_DESCRIPTION =
  "A DeepSeek Harness agent exposed over the A2A protocol. It runs with the deployment's configured agent preset and tools and answers in text."

const STREAM_HISTORY_LIMIT = 500
const CLEANUP_INTERVAL_MS = 60_000

/**
 * Create the A2A server, register its routes, and return its lifecycle control.
 * @param {{ ctx: object, config: object, logger?: object }} options plugin context and settings.
 * @returns {{ dispose: () => Promise<void>, card: () => object, stats: () => object, tasks: Map<string, object> }}
 */
export function createA2aServer({ ctx, config, logger }) {
  const agents = ctx.agents
  const webServer = ctx.webServer
  const workingDirectory = ctx.get?.('workingDirectory')
  const defaultModel = ctx.get?.('agentDefaultModel')

  const routePrefix = normalizeRoutePrefix(config.routePrefix)
  const settings = {
    authToken: stringValue(config.authToken),
    corsOrigins: Array.isArray(config.corsOrigins) ? config.corsOrigins.filter(origin => typeof origin === 'string' && origin.length > 0) : [],
    publicUrl: stringValue(config.publicUrl).replace(/\/+$/, ''),
    modelProvider: stringValue(config.modelProvider),
    model: stringValue(config.model),
    reasoningEffort: stringValue(config.reasoningEffort),
    maxTokens: positiveInteger(config.maxTokens),
    cwd: stringValue(config.cwd),
    agentPreset: stringValue(config.agentPreset),
    cardName: stringValue(config.cardName),
    cardDescription: stringValue(config.cardDescription),
    cardVersion: stringValue(config.cardVersion) || '1.0.0',
    iconUrl: stringValue(config.iconUrl),
    documentationUrl: stringValue(config.documentationUrl),
    organization: stringValue(config.organization),
    providerUrl: stringValue(config.providerUrl),
    skills: Array.isArray(config.skills) ? config.skills : [],
    maxTasks: positiveInteger(config.maxTasks) || 100,
    taskTtlSeconds: positiveInteger(config.taskTtlSeconds) || 86_400,
    maxBodyBytes: positiveInteger(config.maxBodyBytes) || 1_048_576,
    maxConcurrentTasks: positiveInteger(config.maxConcurrentTasks) || 8,
    historyLength: nonNegativeInteger(config.historyLength) ?? 50,
    agentTimeoutSeconds: positiveInteger(config.agentTimeoutSeconds) || 900,
  }

  /** @type {Map<string, object>} */
  const tasks = new Map()
  /** @type {Map<string, object>} */
  const contexts = new Map()
  /** @type {Map<string, object>} active job by Agent/Session id */
  const activeJobs = new Map()
  /** @type {Set<Function>} route disposers */
  const routeDisposers = []
  let runningJobs = 0
  let disposed = false

  const log = {
    warn: message => safeLog(logger, 'warn', `a2a: ${message}`),
    info: message => safeLog(logger, 'info', `a2a: ${message}`),
  }

  // ---- HTTP entry points -------------------------------------------------

  const cardHandler = (req, res) => {
    if (applyCors(req, res, 'GET, HEAD, OPTIONS', settings.corsOrigins)) return
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      methodNotAllowed(res, 'GET, HEAD, OPTIONS')
      return
    }
    const body = JSON.stringify(buildCard())
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  const rpcHandler = async (req, res) => {
    if (applyCors(req, res, 'POST, OPTIONS', settings.corsOrigins)) return
    if (req.method !== 'POST') {
      methodNotAllowed(res, 'POST, OPTIONS')
      return
    }
    if (!authorized(req)) {
      res.writeHead(401, {
        'content-type': 'application/json; charset=utf-8',
        'www-authenticate': 'Bearer realm="a2a"',
        ...corsHeaders(req, settings.corsOrigins),
      })
      res.end(JSON.stringify(rpcError(null, new A2aError(-32_600, 'Unauthorized', {}, 'UNAUTHORIZED'))))
      return
    }
    let body
    try {
      body = await readBody(req, settings.maxBodyBytes)
    } catch (error) {
      if (error instanceof HttpError) {
        res.writeHead(error.status, { 'content-type': 'text/plain; charset=utf-8', ...corsHeaders(req, settings.corsOrigins) })
        res.end(error.message)
      } else {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', ...corsHeaders(req, settings.corsOrigins) })
        res.end('Bad request')
      }
      return
    }
    let request
    try {
      request = JSON.parse(body)
    } catch (error) {
      writeJson(res, 200, rpcError(null, errors.parse(error.message)), req, settings.corsOrigins)
      return
    }
    let id = null
    try {
      if (request === null || typeof request !== 'object' || Array.isArray(request)) {
        throw errors.invalidRequest('expected a single JSON-RPC request object')
      }
      if (request.jsonrpc !== '2.0') throw errors.invalidRequest('jsonrpc must be "2.0"')
      if (typeof request.method !== 'string' || request.method.length === 0) {
        throw errors.invalidRequest('method must be a non-empty string')
      }
      if (!Object.hasOwn(request, 'id')) throw errors.invalidRequest('id is required')
      id = request.id ?? null
      assertSupportedVersion(req)
      const legacy = Object.hasOwn(LEGACY_METHODS, request.method)
      const method = legacy ? LEGACY_METHODS[request.method] : request.method
      const params = request.params ?? {}
      if (method === METHODS.STREAM) {
        await handleStreamingMessage(req, res, id, params, legacy)
        return
      }
      if (method === METHODS.SUBSCRIBE) {
        await handleSubscribe(req, res, id, params, legacy)
        return
      }
      const result = await dispatch(method, params, legacy)
      if (!res.writableEnded && !res.destroyed) writeJson(res, 200, rpcResult(id, result), req, settings.corsOrigins)
    } catch (error) {
      if (!res.headersSent) {
        writeJson(res, 200, rpcError(id, error), req, settings.corsOrigins)
      } else {
        log.warn(`request failed after headers: ${errorChain(error)}`)
        try {
          res.end()
        } catch {
          // The client already closed the connection.
        }
      }
    }
  }

  const healthHandler = (req, res) => {
    if (applyCors(req, res, 'GET, HEAD, OPTIONS', settings.corsOrigins)) return
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      methodNotAllowed(res, 'GET, HEAD, OPTIONS')
      return
    }
    writeJson(res, 200, {
      ok: true,
      protocolVersion: '1.0',
      endpoint: `${baseUrl()}${routePrefix}`,
      tasks: tasks.size,
      contexts: contexts.size,
      running: runningJobs,
      authRequired: settings.authToken.length > 0,
      loopbackOnly: settings.authToken.length === 0,
    }, req, settings.corsOrigins)
  }

  let iconPromise
  const loadIcon = () => {
    iconPromise ??= readFile(new URL('../icon.svg', import.meta.url), 'utf8').catch((error) => {
      iconPromise = undefined
      throw error
    })
    return iconPromise
  }

  const iconHandler = async (req, res) => {
    if (applyCors(req, res, 'GET, HEAD, OPTIONS', settings.corsOrigins)) return
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      methodNotAllowed(res, 'GET, HEAD, OPTIONS')
      return
    }
    let svg
    try {
      svg = await loadIcon()
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...corsHeaders(req, settings.corsOrigins) })
      res.end('No icon')
      return
    }
    res.writeHead(200, {
      'content-type': 'image/svg+xml; charset=utf-8',
      'content-length': Buffer.byteLength(svg),
      'cache-control': 'public, max-age=3600',
      ...corsHeaders(req, settings.corsOrigins),
    })
    res.end(req.method === 'HEAD' ? undefined : svg)
  }

  try {
    routeDisposers.push(webServer.register({ kind: 'exact', path: '/.well-known/agent-card.json', handler: cardHandler }))
    routeDisposers.push(webServer.register({ kind: 'exact', path: '/.well-known/agent.json', handler: cardHandler }))
    routeDisposers.push(webServer.register({ kind: 'prefix', path: routePrefix, handler: rpcHandler }))
    routeDisposers.push(webServer.register({ kind: 'prefix', path: `${routePrefix}/health`, handler: healthHandler }))
    routeDisposers.push(webServer.register({ kind: 'exact', path: `${routePrefix}/icon.svg`, handler: iconHandler }))
  } catch (error) {
    for (const dispose of routeDisposers.splice(0)) {
      try {
        dispose()
      } catch {
        // Registration rollback only.
      }
    }
    throw error
  }

  const cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - settings.taskTtlSeconds * 1000
    for (const [id, task] of tasks) {
      if (TERMINAL_STATES.has(task.state) && task.updatedAt < cutoff && task.subscribers.size === 0) {
        tasks.delete(id)
      }
    }
  }, CLEANUP_INTERVAL_MS)
  cleanupTimer.unref?.()

  // ---- Agent and job runtime --------------------------------------------

  const offSessionEvent = ctx.on('session/event', (session, event) => {
    const job = activeJobs.get(session.header.id)
    if (job === undefined || job.agent.session !== session) return
    if (event.type === 'assistant/message') {
      if (job.turn === undefined || event.data.turn !== job.turn) return
      const text = assistantText(event.data.message)
      if (text.length > 0) offerText(job, text)
      return
    }
    if (event.type === 'turn/end') {
      if (job.turn === undefined || event.data.turn !== job.turn) return
      settleJob(job, event.data.reason)
    }
  })

  const offInboxClaimed = ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    const job = activeJobs.get(agent.id)
    if (job === undefined || job.agent !== agent) return
    if (job.messageId === message.id) job.turn = turn
  })

  const offAgentError = ctx.on('agent/error', ({ agent, turn, error }) => {
    const job = activeJobs.get(agent.id)
    if (job === undefined || job.agent !== agent || job.settled) return
    if (job.turn === undefined || job.turn === turn) job.agentError = error
  })

  /** Resolve the Agent handle for one context, creating it on first use. */
  function contextFor(contextId) {
    const existing = contexts.get(contextId)
    if (existing !== undefined) return existing
    const context = {
      id: contextId,
      handlePromise: createContextAgent(),
      agent: undefined,
      running: false,
      queue: [],
      lastUsed: Date.now(),
    }
    context.handlePromise.then(
      handle => { context.agent = handle.agent },
      (error) => {
        contexts.delete(contextId)
        log.warn(`could not create an agent for context ${contextId}: ${errorChain(error)}`)
      },
    )
    contexts.set(contextId, context)
    return context
  }

  /** Create the DSH Agent that serves one A2A context. */
  async function createContextAgent() {
    const agentOptions = {}
    if (settings.modelProvider.length > 0) agentOptions.provider = settings.modelProvider
    if (settings.model.length > 0) agentOptions.model = settings.model
    if (settings.reasoningEffort.length > 0) agentOptions.reasoningEffort = settings.reasoningEffort
    if (settings.maxTokens > 0) agentOptions.maxTokens = settings.maxTokens
    if (agentOptions.provider === undefined || agentOptions.model === undefined) {
      try {
        const selection = defaultModel?.currentSelection?.()
        if (selection?.provider !== undefined && agentOptions.provider === undefined) agentOptions.provider = selection.provider
        if (selection?.model !== undefined && agentOptions.model === undefined) agentOptions.model = selection.model
      } catch {
        // A deployment without a default selection leaves the route to the loop.
      }
    }
    const presets = ctx.get?.('agentPresets')
    let presetId = settings.agentPreset.length > 0 ? settings.agentPreset : undefined
    if (presets !== undefined && presetId === undefined) {
      try {
        presetId = (await presets.resolve()).id
      } catch {
        // No registry default: run with the global composition only.
      }
    }
    const cwd = settings.cwd.length > 0
      ? settings.cwd
      : (workingDirectory?.defaultDirectory ?? process.cwd())
    const handle = await agents.create({
      sessionId: brandString(randomUUID()),
      meta: {
        cwd,
        ...(presetId !== undefined ? { agentPreset: presetId } : {}),
      },
      ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
      setup: async (agentCtx) => {
        if (presets !== undefined && presetId !== undefined) await presets.mount(agentCtx, presetId)
        try {
          const systemPrompt = agentCtx.get?.('systemPrompt')
          systemPrompt?.section?.({
            name: 'a2a:remote-caller',
            order: 3250,
            text: A2A_SESSION_GUIDANCE,
          })
        } catch {
          // A composition without the prompt registry still runs the turn.
        }
      },
    })
    return handle
  }

  /** Enqueue one task onto its context's serial queue. */
  function enqueue(context, task, content) {
    context.queue.push({ task, content, cancelled: false })
    context.lastUsed = Date.now()
    schedule(context)
    scheduleAll()
  }

  /** Start a queued entry when the context and global limits allow it. */
  function schedule(context) {
    if (disposed) return
    if (context.running || context.queue.length === 0) return
    if (runningJobs >= settings.maxConcurrentTasks) return
    const entry = context.queue.shift()
    context.running = true
    runningJobs += 1
    void (async () => {
      try {
        if (entry.cancelled || entry.task.cancelRequested || TERMINAL_STATES.has(entry.task.state)) {
          cancelTask(entry.task)
          return
        }
        const handle = await context.handlePromise
        context.agent = handle.agent
        await runEntry(context, entry)
      } catch (error) {
        log.warn(`a task could not run: ${errorChain(error)}`)
        failTask(entry.task, `The agent could not run this task: ${errorChain(error)}`)
      } finally {
        context.running = false
        runningJobs -= 1
        schedule(context)
        scheduleAll()
      }
    })()
  }

  /** Give every context with pending work a chance to fill a free global slot. */
  function scheduleAll() {
    for (const context of contexts.values()) schedule(context)
  }

  /** Run one entry as a single DSH turn and settle its A2A task. */
  async function runEntry(context, entry) {
    const { task } = entry
    const agent = context.agent
    if (agent === undefined) throw new Error('the A2A context agent is unavailable')
    if (agents.get(agent.id) !== agent) throw new Error('the A2A context agent was disposed')
    if (task.cancelRequested) {
      cancelTask(task)
      return
    }
    setTaskState(task, TASK_STATE.WORKING, agentMessage('Working on the task.', { contextId: task.contextId, taskId: task.id }))
    const job = createJob(task, agent)
    activeJobs.set(agent.id, job)
    let userMessage
    try {
      userMessage = createUserMessage({ content: entry.content, source: { kind: 'user' } })
      job.messageId = userMessage.id
      agent.followup(userMessage)
    } catch (error) {
      activeJobs.delete(agent.id)
      failTask(task, `The agent did not accept the message: ${errorChain(error)}`)
      return
    }
    job.timer = setTimeout(() => {
      job.timedOut = true
      try {
        agent.cancel({ kind: 'user' })
      } catch {
        // Cancellation races teardown; settlement still records the timeout.
      }
      settleJob(job, { kind: 'aborted', reason: { kind: 'user' } })
    }, settings.agentTimeoutSeconds * 1000)
    job.timer.unref?.()
    await job.done.promise
  }

  /** Create an in-flight job around one A2A task. */
  function createJob(task, agent) {
    return {
      task,
      agent,
      messageId: undefined,
      turn: undefined,
      texts: [],
      pendingText: undefined,
      artifact: undefined,
      settled: false,
      timedOut: false,
      agentError: undefined,
      timer: undefined,
      done: Promise.withResolvers(),
    }
  }

  /** Hold the newest assistant text until the turn ends so `lastChunk` is accurate. */
  function offerText(job, text) {
    if (job.pendingText !== undefined) emitArtifactChunk(job, job.pendingText, false)
    job.pendingText = text
  }

  /** Append one committed assistant message to the task's single response artifact. */
  function emitArtifactChunk(job, text, lastChunk) {
    const task = job.task
    if (job.artifact === undefined) {
      job.artifact = { artifactId: randomUUID(), name: 'response', parts: [] }
      task.artifacts.push(job.artifact)
    }
    const append = job.artifact.parts.length > 0
    job.artifact.parts.push({ type: 'text', text })
    job.texts.push(text)
    emit(task, serializeArtifactUpdate(task, job.artifact, append, lastChunk, task.legacy))
  }

  /** Close the artifact stream with a final empty chunk when the last text was already sent. */
  function finalizeArtifact(job) {
    const task = job.task
    if (job.pendingText !== undefined) {
      emitArtifactChunk(job, job.pendingText, true)
      job.pendingText = undefined
      return
    }
    if (job.artifact === undefined) {
      const text = job.texts.length > 0 ? job.texts.join('\n\n') : 'The agent completed the task without textual output.'
      job.artifact = { artifactId: randomUUID(), name: 'response', parts: [] }
      task.artifacts.push(job.artifact)
      emitArtifactChunk(job, text, true)
      return
    }
    emit(task, serializeArtifactUpdate(task, job.artifact, true, true, task.legacy, [{ type: 'text', text: '' }]))
  }

  /** Settle a job from its turn ending. */
  function settleJob(job, reason) {
    if (job.settled) return
    job.settled = true
    if (job.timer !== undefined) clearTimeout(job.timer)
    activeJobs.delete(job.agent.id)
    const task = job.task
    if (job.timedOut) {
      failTask(task, `The agent did not finish within ${settings.agentTimeoutSeconds} seconds.`)
    } else if (reason.kind === 'completed') {
      completeTask(job)
    } else if (reason.kind === 'aborted') {
      finalizeArtifact(job)
      cancelTask(task, `Task canceled (${reason.reason?.kind ?? 'aborted'}).`)
    } else if (reason.kind === 'error') {
      failTask(task, `The agent turn failed: ${reason.error?.message ?? 'unknown error'}`)
    } else if (reason.kind === 'max-tokens') {
      failTask(task, 'The model reached its output token limit before finishing.')
    } else if (reason.kind === 'blocked') {
      failTask(task, 'The agent blocked this request.')
    } else {
      failTask(task, `The agent turn ended as ${reason.kind}.`)
    }
    job.done.resolve()
  }

  /** Complete a task with the assistant text collected during its turn. */
  function completeTask(job) {
    const task = job.task
    if (TERMINAL_STATES.has(task.state)) return
    finalizeArtifact(job)
    const text = job.texts.join('\n\n').trim()
    const message = agentMessage(text.length > 0 ? text : 'The agent completed the task without textual output.', {
      contextId: task.contextId,
      taskId: task.id,
    })
    task.history.push(message)
    setTaskState(task, TASK_STATE.COMPLETED, message)
    task.completion.resolve(task)
  }

  /** Fail a task with a diagnostic status message. */
  function failTask(task, detail) {
    if (TERMINAL_STATES.has(task.state)) return
    const message = agentMessage(detail, { contextId: task.contextId, taskId: task.id })
    task.history.push(message)
    setTaskState(task, TASK_STATE.FAILED, message)
    task.completion.resolve(task)
  }

  /** Cancel a task and stop its running turn or drop its queued entry. */
  function cancelTask(task, detail = 'Task canceled by the client.') {
    if (TERMINAL_STATES.has(task.state)) return
    task.cancelRequested = true
    const context = contexts.get(task.contextId)
    if (context !== undefined) {
      for (const entry of context.queue) {
        if (entry.task === task) entry.cancelled = true
      }
      const job = context.agent === undefined ? undefined : activeJobs.get(context.agent.id)
      if (job !== undefined && job.task === task) {
        try {
          context.agent.cancel({ kind: 'user' })
        } catch {
          // Teardown already stopped the agent.
        }
      }
    }
    const message = agentMessage(detail, { contextId: task.contextId, taskId: task.id })
    task.history.push(message)
    setTaskState(task, TASK_STATE.CANCELED, message)
    task.completion.resolve(task)
  }

  /** Move a task to a new state and publish its status update. */
  function setTaskState(task, state, message) {
    task.state = state
    task.statusTimestamp = timestamp()
    task.updatedAt = Date.now()
    if (message !== undefined) task.statusMessage = message
    emit(task, serializeStatusUpdate(task, task.legacy))
  }

  /** Publish one stream event to every current subscriber. */
  function emit(task, payload) {
    task.events.push(payload)
    if (task.events.length > STREAM_HISTORY_LIMIT) task.events.shift()
    for (const subscriber of [...task.subscribers]) {
      try {
        subscriber.send(payload)
      } catch (error) {
        task.subscribers.delete(subscriber)
        log.warn(`stream subscriber failed: ${errorChain(error)}`)
      }
    }
    if (TERMINAL_STATES.has(task.state)) {
      for (const subscriber of [...task.subscribers]) {
        task.subscribers.delete(subscriber)
        try {
          subscriber.end()
        } catch {
          // The response is already closed.
        }
      }
    }
  }

  // ---- JSON-RPC dispatch -------------------------------------------------

  /** Dispatch one non-streaming method. */
  async function dispatch(method, params, legacy) {
    switch (method) {
      case METHODS.SEND:
        return sendMessage(params, legacy)
      case METHODS.GET:
        return getTask(params, legacy)
      case METHODS.LIST:
        return listTasks(params, legacy)
      case METHODS.CANCEL:
        return cancelTaskRequest(params, legacy)
      case METHODS.PUSH_CREATE:
      case METHODS.PUSH_GET:
      case METHODS.PUSH_LIST:
      case METHODS.PUSH_DELETE:
        throw errors.pushNotSupported()
      case METHODS.CARD:
        throw errors.extendedCard()
      case METHODS.STREAM:
      case METHODS.SUBSCRIBE:
        throw errors.unsupported(`${method} requires a streaming response`)
      default:
        throw errors.methodNotFound(method)
    }
  }

  /** Admit one A2A message, start or continue its task, and optionally wait. */
  async function sendMessage(params, legacy) {
    if (params === null || typeof params !== 'object') throw errors.invalidParams('params must be an object')
    const configuration = params.configuration ?? params.sendMessageConfiguration ?? {}
    const incoming = parseMessage(params.message)
    const wait = !(configuration?.returnImmediately === true || configuration?.blocking === false || params.blocking === false)
    let task
    if (incoming.taskId !== undefined) {
      task = tasks.get(incoming.taskId)
      if (task === undefined) throw errors.taskNotFound(incoming.taskId)
      if (TERMINAL_STATES.has(task.state)) {
        throw errors.invalidParams(`task ${incoming.taskId} is already terminal; send a new message without taskId`)
      }
      if (incoming.contextId !== undefined && incoming.contextId !== task.contextId) {
        throw errors.invalidParams('message.contextId does not match the task context')
      }
      incoming.taskId = task.id
      incoming.contextId = task.contextId
      task.history.push(incoming)
      task.updatedAt = Date.now()
      setTaskState(task, TASK_STATE.WORKING, agentMessage('Working on the follow-up message.', { contextId: task.contextId, taskId: task.id }))
      const context = contextFor(task.contextId)
      enqueue(context, task, contentOf(incoming))
    } else {
      task = createTask(incoming, legacy)
      const context = contextFor(task.contextId)
      enqueue(context, task, contentOf(incoming))
    }
    const respond = () => {
      const snapshot = serializeTask(task, { historyLength: settings.historyLength, includeArtifacts: true, legacy })
      // v1.0 SendMessageResponse is a oneof payload; v0.3 returned the Task directly.
      return legacy ? snapshot : { task: snapshot }
    }
    if (!wait) return respond()
    await task.completion.promise
    return respond()
  }

  /** Create the internal task record for a fresh message. */
  function createTask(incoming, legacy) {
    pruneTasks()
    const contextId = incoming.contextId ?? randomUUID()
    const task = {
      id: randomUUID(),
      contextId,
      legacy,
      state: TASK_STATE.SUBMITTED,
      statusTimestamp: timestamp(),
      statusMessage: undefined,
      artifacts: [],
      history: [{ ...incoming, contextId, taskId: undefined }],
      events: [],
      subscribers: new Set(),
      cancelRequested: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completion: Promise.withResolvers(),
    }
    tasks.set(task.id, task)
    emit(task, serializeStatusUpdate(task, legacy))
    return task
  }

  /** Drop the oldest terminal task when the store is full. */
  function pruneTasks() {
    if (tasks.size < settings.maxTasks) return
    const terminal = [...tasks.values()]
      .filter(task => TERMINAL_STATES.has(task.state) && task.subscribers.size === 0)
      .sort((left, right) => left.updatedAt - right.updatedAt)
    while (tasks.size >= settings.maxTasks && terminal.length > 0) {
      const victim = terminal.shift()
      tasks.delete(victim.id)
    }
    if (tasks.size >= settings.maxTasks) throw errors.internal('the A2A task store is full')
  }

  /** Convert parsed message text parts into model content blocks. */
  function contentOf(message) {
    const content = message.parts.map(part => ({ type: 'text', text: part.text }))
    return content.length > 0 ? content : [{ type: 'text', text: '(empty A2A message)' }]
  }

  /** Read one task with its requested history projection. */
  function getTask(params, legacy) {
    const taskId = taskIdOf(params)
    const task = tasks.get(taskId)
    if (task === undefined) throw errors.taskNotFound(taskId)
    const historyLength = nonNegativeInteger(params.historyLength) ?? settings.historyLength
    return serializeTask(task, { historyLength, includeArtifacts: true, legacy })
  }

  /** List tasks with opaque offset pagination. */
  function listTasks(params, legacy) {
    const contextId = typeof params.contextId === 'string' ? params.contextId : undefined
    const state = typeof params.status === 'string' ? normalizeState(params.status) : undefined
    const pageSize = clamp(nonNegativeInteger(params.pageSize) ?? 50, 1, 100)
    const offset = decodePageToken(params.pageToken)
    const historyLength = nonNegativeInteger(params.historyLength) ?? settings.historyLength
    const includeArtifacts = params.includeArtifacts !== false
    const filtered = [...tasks.values()]
      .filter(task => contextId === undefined || task.contextId === contextId)
      .filter(task => state === undefined || task.state === state)
      .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)
    const page = filtered.slice(offset, offset + pageSize)
    const nextOffset = offset + page.length
    return {
      tasks: page.map(task => serializeTask(task, { historyLength, includeArtifacts, legacy })),
      nextPageToken: nextOffset < filtered.length ? encodePageToken(nextOffset) : '',
      pageSize: page.length,
      totalSize: filtered.length,
    }
  }

  /** Cancel a task and return its current snapshot. */
  function cancelTaskRequest(params, legacy) {
    const taskId = taskIdOf(params)
    const task = tasks.get(taskId)
    if (task === undefined) throw errors.taskNotFound(taskId)
    if (TERMINAL_STATES.has(task.state)) throw errors.taskNotCancelable(taskId)
    cancelTask(task)
    return serializeTask(task, { historyLength: settings.historyLength, includeArtifacts: true, legacy })
  }

  // ---- Streaming ---------------------------------------------------------

  /** Serve `SendStreamingMessage`. */
  async function handleStreamingMessage(req, res, id, params, legacy) {
    if (params === null || typeof params !== 'object') throw errors.invalidParams('params must be an object')
    const incoming = parseMessage(params.message)
    let task
    if (incoming.taskId !== undefined) {
      task = tasks.get(incoming.taskId)
      if (task === undefined) throw errors.taskNotFound(incoming.taskId)
      if (TERMINAL_STATES.has(task.state)) {
        throw errors.invalidParams(`task ${incoming.taskId} is already terminal; send a new message without taskId`)
      }
      incoming.taskId = task.id
      incoming.contextId = task.contextId
      task.history.push(incoming)
      task.updatedAt = Date.now()
      setTaskState(task, TASK_STATE.WORKING, agentMessage('Working on the follow-up message.', { contextId: task.contextId, taskId: task.id }))
    } else {
      task = createTask(incoming, legacy)
    }
    const stream = openSse(req, res, id, task)
    stream.send(initialTaskPayload(task))
    subscribe(task, stream)
    const context = contextFor(task.contextId)
    enqueue(context, task, contentOf(incoming))
    if (TERMINAL_STATES.has(task.state)) stream.end()
  }

  /** Serve `SubscribeToTask`. */
  async function handleSubscribe(req, res, id, params, legacy) {
    const taskId = taskIdOf(params)
    const task = tasks.get(taskId)
    if (task === undefined) throw errors.taskNotFound(taskId)
    if (TERMINAL_STATES.has(task.state)) {
      throw errors.unsupported(`task ${taskId} is already terminal`)
    }
    const stream = openSse(req, res, id, task)
    stream.send(initialTaskPayload(task))
    subscribe(task, stream)
  }

  /** The first event of a task stream is the current Task snapshot. */
  function initialTaskPayload(task) {
    const snapshot = serializeTask(task, { historyLength: 0, includeArtifacts: true })
    return task.legacy ? snapshot : { task: snapshot }
  }

  /** Register one live SSE writer on a task. */
  function subscribe(task, stream) {
    task.subscribers.add(stream)
    stream.onClose(() => task.subscribers.delete(stream))
  }

  /** Open an SSE response and return a writer carrying JSON-RPC envelopes. */
  function openSse(req, res, id, task) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
      ...corsHeaders(req, settings.corsOrigins),
    })
    res.flushHeaders?.()
    let closed = false
    let closeListener = () => {}
    const ping = setInterval(() => {
      if (!closed) res.write(': ping\n\n')
    }, 15_000)
    ping.unref?.()
    const cleanup = () => {
      if (closed) return
      closed = true
      clearInterval(ping)
      try {
        closeListener()
      } catch {
        // Subscriber cleanup only.
      }
    }
    res.on('close', cleanup)
    return {
      send(payload) {
        if (closed) return
        res.write(`data: ${JSON.stringify(rpcResult(id, payload))}\n\n`)
      },
      end() {
        if (closed) return
        cleanup()
        try {
          res.end()
        } catch {
          // The client already closed the connection.
        }
      },
      onClose(listener) {
        closeListener = listener
      },
      get closed() {
        return closed
      },
      task,
    }
  }

  // ---- Agent card and helpers -------------------------------------------

  /** The advertised A2A endpoint, absolute whenever the listener is bound. */
  function baseUrl() {
    if (settings.publicUrl.length > 0) return settings.publicUrl
    try {
      return webServer.getOrigin()
    } catch {
      return `http://127.0.0.1${webServer.port === undefined ? '' : `:${webServer.port}`}`
    }
  }

  /** Build the Agent Card. It carries both v1.0 and v0.3 discovery fields. */
  function buildCard() {
    const endpoint = `${baseUrl()}${routePrefix}`
    const description = settings.cardDescription.length > 0 ? settings.cardDescription : DEFAULT_CARD_DESCRIPTION
    const skills = settings.skills.length > 0
      ? settings.skills.map(skill => ({
        id: skill.id,
        name: skill.name,
        description: typeof skill.description === 'string' && skill.description.length > 0 ? skill.description : skill.name,
        tags: Array.isArray(skill.tags) && skill.tags.length > 0 ? skill.tags : ['dsh'],
        ...(Array.isArray(skill.examples) && skill.examples.length > 0 ? { examples: skill.examples } : {}),
      }))
      : [{ id: 'dsh-agent', name: 'DeepSeek Harness agent', description, tags: ['dsh', 'agent', 'coding'] }]
    const card = {
      name: settings.cardName.length > 0 ? settings.cardName : 'DeepSeek Harness agent',
      description,
      version: settings.cardVersion,
      supportedInterfaces: [{ url: endpoint, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
      capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false },
      defaultInputModes: ['text/plain', 'application/json'],
      defaultOutputModes: ['text/plain', 'application/json'],
      skills,
      // v0.3 discovery compatibility: these fields are additive and ignored by 1.0 readers.
      url: endpoint,
      protocolVersion: '1.0',
      preferredTransport: 'JSONRPC',
      additionalInterfaces: [{ url: endpoint, transport: 'JSONRPC' }],
      supportsAuthenticatedExtendedCard: false,
    }
    if (settings.iconUrl.length > 0) card.iconUrl = settings.iconUrl
    else card.iconUrl = `${baseUrl()}${routePrefix}/icon.svg`
    if (settings.documentationUrl.length > 0) card.documentationUrl = settings.documentationUrl
    if (settings.organization.length > 0 && settings.providerUrl.length > 0) {
      card.provider = { organization: settings.organization, url: settings.providerUrl }
    }
    if (settings.authToken.length > 0) {
      card.securitySchemes = {
        bearer: { httpAuthSecurityScheme: { scheme: 'Bearer', bearerFormat: 'JWT' } },
      }
      card.securityRequirements = [{ schemes: { bearer: { list: [] } } }]
      card.security = [{ bearer: [] }]
    }
    return card
  }

  /** Reject an explicitly unsupported protocol version header. */
  function assertSupportedVersion(req) {
    const header = req.headers['a2a-version']
    if (header === undefined) return
    const value = Array.isArray(header) ? header[0] : header
    if (value === undefined || value.length === 0) return
    const major = String(value).trim().split('.')[0]
    if (major === '1' || major === '0') return
    throw errors.version(String(value))
  }

  /** Check the configured bearer token, or loopback when no token is configured. */
  function authorized(req) {
    if (settings.authToken.length === 0) return isLoopbackAddress(req.socket?.remoteAddress)
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match === null) return false
    const given = Buffer.from(match[1], 'utf8')
    const expected = Buffer.from(settings.authToken, 'utf8')
    return given.length === expected.length && timingSafeEqual(given, expected)
  }

  // ---- Cleanup -----------------------------------------------------------

  /** Remove routes, settle live tasks, and dispose A2A context agents. */
  async function dispose() {
    if (disposed) return
    disposed = true
    clearInterval(cleanupTimer)
    for (const remove of routeDisposers.splice(0)) {
      try {
        remove()
      } catch {
        // Route removal is best-effort during unload.
      }
    }
    try {
      offSessionEvent()
      offInboxClaimed()
      offAgentError()
    } catch {
      // Listener removal during context teardown.
    }
    for (const task of tasks.values()) {
      task.cancelRequested = true
      for (const subscriber of [...task.subscribers]) {
        task.subscribers.delete(subscriber)
        try {
          subscriber.end()
        } catch {
          // The response is already gone.
        }
      }
      if (!TERMINAL_STATES.has(task.state)) {
        try {
          setTaskState(task, TASK_STATE.CANCELED, agentMessage('The A2A bridge was disposed.', { contextId: task.contextId, taskId: task.id }))
          task.completion.resolve(task)
        } catch {
          // The task is already settling.
        }
      }
    }
    for (const job of [...activeJobs.values()]) {
      if (job.timer !== undefined) clearTimeout(job.timer)
      try {
        job.agent.cancel({ kind: 'user' })
      } catch {
        // Agent teardown already ran.
      }
    }
    activeJobs.clear()
    const handles = []
    for (const context of contexts.values()) {
      handles.push(context.handlePromise.then(handle => handle.dispose()).catch(() => {}))
    }
    contexts.clear()
    await Promise.allSettled(handles)
    tasks.clear()
  }

  return {
    dispose,
    card: buildCard,
    stats: () => ({ tasks: tasks.size, contexts: contexts.size, running: runningJobs }),
    tasks,
  }
}

// ---- Small HTTP helpers --------------------------------------------------

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function stringValue(value) {
  return typeof value === 'string' ? value : ''
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function normalizeRoutePrefix(value) {
  let prefix = stringValue(value).trim()
  if (prefix.length === 0) prefix = '/a2a'
  if (!prefix.startsWith('/')) prefix = `/${prefix}`
  prefix = prefix.replace(/\/+$/, '')
  return prefix.length === 0 ? '/a2a' : prefix
}

function safeLog(logger, level, message) {
  try {
    if (logger !== undefined && typeof logger[level] === 'function') logger[level](message)
  } catch {
    // Logging never affects protocol behavior.
  }
}

function corsHeaders(req, origins) {
  const origin = typeof req?.headers?.origin === 'string' ? req.headers.origin : undefined
  if (origin === undefined) return {}
  if (!origins.includes('*') && !origins.includes(origin)) return {}
  return {
    'access-control-allow-origin': origin,
    'vary': 'origin',
    'access-control-allow-headers': 'authorization, content-type, a2a-version, a2a-extensions',
    'access-control-allow-methods': 'POST, GET, HEAD, OPTIONS',
    'access-control-expose-headers': 'content-type',
  }
}

/** Answer a CORS preflight and report whether the request was consumed. */
function applyCors(req, res, methods, origins) {
  const headers = corsHeaders(req, origins)
  if (req.method === 'OPTIONS') {
    if (Object.keys(headers).length === 0) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('CORS origin not allowed')
      return true
    }
    res.writeHead(204, { ...headers, 'access-control-allow-methods': methods, 'access-control-max-age': '600' })
    res.end()
    return true
  }
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
  return false
}

function writeJson(res, status, value, req, origins) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...corsHeaders(req, origins),
  })
  res.end(body)
}

function methodNotAllowed(res, allow) {
  res.writeHead(405, { allow, 'content-type': 'text/plain; charset=utf-8' })
  res.end(`Method not allowed; expected ${allow}`)
}

/** Whether a socket peer address is IPv4 or IPv6 loopback. */
function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  const value = address.toLowerCase()
  return value === '::1' || value.startsWith('127.') || value.startsWith('::ffff:127.')
}

/** Read a bounded request body as UTF-8 text. */
async function readBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, 'Request body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function taskIdOf(params) {
  const id = params?.id ?? params?.taskId
  if (typeof id !== 'string' || id.length === 0) throw errors.invalidParams('task id is required')
  return id
}

function encodePageToken(offset) {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url')
}

function decodePageToken(token) {
  if (token === undefined || token === null || token === '') return 0
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]+$/.test(token)) throw errors.invalidParams('pageToken is invalid')
  try {
    const decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
    if (decoded === null || typeof decoded !== 'object' || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0) {
      throw new Error('invalid offset')
    }
    return decoded.offset
  } catch {
    throw errors.invalidParams('pageToken is invalid')
  }
}
