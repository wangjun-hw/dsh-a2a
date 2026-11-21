/**
 * Outbound A2A client used by the chat tools.
 *
 * It speaks A2A v1.0 JSON-RPC (`SendMessage`, `GetTask`, `CancelTask`) to a
 * remote endpoint, discovers endpoints from an agent card when needed, and
 * normalizes tasks and messages into a compact model-facing summary.
 */

import { randomUUID } from 'node:crypto'

const CARD_PATH = '/.well-known/agent-card.json'
const CARD_TTL_MS = 5 * 60_000

/** Error raised for a remote JSON-RPC failure. */
export class A2aRemoteError extends Error {
  constructor(code, message, data) {
    super(`A2A error ${code}: ${message}`)
    this.name = 'A2aRemoteError'
    this.code = code
    this.data = data
  }
}

/**
 * Create the outbound client.
 * @param {{ config: object, logger?: object }} options plugin settings.
 */
export function createA2aClient({ config, logger }) {
  const settings = {
    timeoutMs: positiveInteger(config.clientTimeoutMs) || 600_000,
    headers: config.clientHeaders !== null && typeof config.clientHeaders === 'object' ? config.clientHeaders : {},
    token: typeof config.clientToken === 'string' ? config.clientToken : '',
    peers: Array.isArray(config.peers) ? config.peers : [],
  }
  /** @type {Map<string, { card: object, at: number }>} */
  const cardCache = new Map()

  /** Find a configured peer by its configured name. */
  function peer(name) {
    return settings.peers.find(candidate => candidate.name === name)
  }

  /**
   * Resolve a peer name or URL to an invocation target.
   * @param {string} agent peer name, endpoint URL, or agent-card URL.
   * @param {AbortSignal} [signal] caller cancellation.
   */
  async function resolve(agent, signal) {
    if (typeof agent !== 'string' || agent.trim().length === 0) {
      throw new Error('agent must be a configured peer name or an http(s) URL')
    }
    const name = agent.trim()
    const configured = peer(name)
    if (configured !== undefined) {
      return { name: configured.name, endpoint: configured.url, token: configured.token ?? settings.token, card: undefined }
    }
    if (!/^https?:\/\//i.test(name)) {
      const known = settings.peers.map(candidate => candidate.name).join(', ') || '(none configured)'
      throw new Error(`Unknown A2A peer ${JSON.stringify(name)}. Configured peers: ${known}. Pass a configured peer name or an http(s) endpoint URL.`)
    }
    let url
    try {
      url = new URL(name)
    } catch {
      throw new Error(`Invalid A2A URL ${JSON.stringify(name)}; expected an http(s) URL or a configured peer name.`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`A2A URL must use http or https: ${name}`)
    try {
      const card = await getCard(url.toString(), signal)
      return {
        name: card.name ?? url.host,
        endpoint: endpointOf(card, url.toString()),
        token: settings.token,
        card,
      }
    } catch (error) {
      // A URL that already looks like an endpoint is used directly when the
      // origin publishes no card; a root URL must publish one.
      if (url.pathname === '/' || url.pathname === '') throw error
      return { name: url.host, endpoint: url.toString(), token: settings.token, card: undefined }
    }
  }

  /** Fetch and cache one Agent Card. */
  async function getCard(input, signal) {
    const url = new URL(input)
    const cardUrl = url.pathname === '/' || url.pathname === ''
      ? new URL(CARD_PATH, url).toString()
      : url.pathname.endsWith('.json')
        ? url.toString()
        : new URL(CARD_PATH, url.origin).toString()
    const cached = cardCache.get(cardUrl)
    if (cached !== undefined && Date.now() - cached.at < CARD_TTL_MS) return cached.card
    const response = await fetch(cardUrl, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: withTimeout(signal, settings.timeoutMs),
    })
    if (!response.ok) throw new Error(`Agent card request failed with HTTP ${response.status}`)
    const card = await response.json()
    if (card === null || typeof card !== 'object') throw new Error('Agent card was not a JSON object')
    cardCache.set(cardUrl, { card, at: Date.now() })
    return card
  }

  /** Pick the JSON-RPC interface URL from a v1.0 or v0.3 agent card. */
  function endpointOf(card, fallback) {
    const interfaces = Array.isArray(card.supportedInterfaces) ? card.supportedInterfaces : []
    const jsonrpc = interfaces.find(entry => typeof entry?.url === 'string' && /jsonrpc/i.test(entry.protocolBinding ?? entry.transport ?? ''))
      ?? interfaces.find(entry => typeof entry?.url === 'string')
    if (jsonrpc !== undefined) return new URL(jsonrpc.url, fallback).toString()
    if (typeof card.url === 'string') return new URL(card.url, fallback).toString()
    return fallback
  }

  /** Invoke one JSON-RPC method with a bounded deadline. */
  async function rpc(endpoint, method, params, { token, signal } = {}) {
    const headers = {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
      'a2a-version': '1.0',
      ...stringRecord(settings.headers),
    }
    if (typeof token === 'string' && token.length > 0) headers.authorization = `Bearer ${token}`
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: withTimeout(signal, settings.timeoutMs),
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`A2A request failed with HTTP ${response.status}: ${text.slice(0, 400)}`)
    }
    let envelope
    try {
      envelope = JSON.parse(text)
    } catch (error) {
      throw new Error(`A2A endpoint returned non-JSON content: ${error.message}`)
    }
    if (envelope?.error !== undefined) {
      throw new A2aRemoteError(envelope.error.code ?? -32_603, envelope.error.message ?? 'remote failure', envelope.error.data)
    }
    if (envelope?.result === undefined) throw new Error('A2A endpoint returned neither result nor error')
    return envelope.result
  }

  /** Send one text message, optionally waiting for a terminal task. */
  async function sendMessage({ agent, message, taskId, contextId, wait = true, signal }) {
    const target = await resolve(agent, signal)
    const messageId = randomUUID()
    const payload = {
      message: {
        messageId,
        role: 'ROLE_USER',
        parts: [{ text: String(message), mediaType: 'text/plain' }],
        ...(taskId === undefined ? {} : { taskId }),
        ...(contextId === undefined ? {} : { contextId }),
      },
      configuration: {
        acceptedOutputModes: ['text/plain', 'application/json'],
        returnImmediately: !wait,
      },
    }
    const result = await callWithLegacyFallback(
      target,
      'SendMessage',
      payload,
      'message/send',
      {
        message: {
          kind: 'message',
          messageId,
          role: 'user',
          parts: [{ kind: 'text', text: String(message) }],
          ...(taskId === undefined ? {} : { taskId }),
          ...(contextId === undefined ? {} : { contextId }),
        },
        configuration: {
          acceptedOutputModes: ['text/plain', 'application/json'],
          blocking: wait,
        },
      },
      signal,
      legacyTaskResult,
    )
    const settled = isTerminal(result) || !wait ? result : await waitForTask(target, result, signal)
    return summarize(settled, target)
  }

  /** Poll a remote task until it reaches a terminal state. */
  async function waitForTask(target, result, signal) {
    const taskId = result?.task?.id
    if (typeof taskId !== 'string') return result
    const deadline = Date.now() + settings.timeoutMs
    let current = result
    while (!isTerminal(current)) {
      if (Date.now() > deadline) throw new Error(`A2A task ${taskId} did not finish within ${Math.round(settings.timeoutMs / 1000)} seconds`)
      await sleep(1_000, signal)
      current = legacyTaskResult(await callWithLegacyFallback(
        target,
        'GetTask',
        { id: taskId, historyLength: 0 },
        'tasks/get',
        { id: taskId, historyLength: 0 },
        signal,
        legacyTaskResult,
      ))
    }
    return current
  }

  /** Read one task. */
  async function getTask({ agent, taskId, historyLength, signal }) {
    const target = await resolve(agent, signal)
    const params = { id: taskId, ...(historyLength === undefined ? {} : { historyLength }) }
    return summarize(
      legacyTaskResult(await callWithLegacyFallback(target, 'GetTask', params, 'tasks/get', params, signal, legacyTaskResult)),
      target,
    )
  }

  /** Cancel one task. */
  async function cancelTask({ agent, taskId, signal }) {
    const target = await resolve(agent, signal)
    return summarize(
      legacyTaskResult(await callWithLegacyFallback(
        target,
        'CancelTask',
        { id: taskId },
        'tasks/cancel',
        { id: taskId },
        signal,
        legacyTaskResult,
      )),
      target,
    )
  }

  /**
   * Call the v1.0 method, retrying the v0.3 alias when the peer reports the
   * method as unknown, and normalize the legacy bare-Task result.
   */
  async function callWithLegacyFallback(target, method, params, legacyMethod, legacyParams, signal, normalize) {
    try {
      return await rpc(target.endpoint, method, params, { token: target.token, signal })
    } catch (error) {
      if (!(error instanceof A2aRemoteError) || error.code !== -32_601) throw error
      const legacyResult = await rpc(target.endpoint, legacyMethod, legacyParams, { token: target.token, signal })
      return normalize(legacyResult)
    }
  }

  /** Read and summarize one remote Agent Card. */
  async function agentCard({ agent, signal }) {
    const target = await resolve(agent, signal)
    const card = target.card ?? await getCard(target.endpoint, signal)
    const interfaces = Array.isArray(card.supportedInterfaces) && card.supportedInterfaces.length > 0
      ? card.supportedInterfaces.map(entry => ({
        url: entry.url,
        protocolBinding: entry.protocolBinding ?? entry.transport ?? 'JSONRPC',
        protocolVersion: entry.protocolVersion ?? card.protocolVersion ?? '',
      }))
      : [{ url: card.url ?? target.endpoint, protocolBinding: card.preferredTransport ?? 'JSONRPC', protocolVersion: card.protocolVersion ?? '' }]
    return {
      ok: true,
      endpoint: target.endpoint,
      name: card.name,
      description: card.description,
      version: card.version,
      interfaces,
      capabilities: card.capabilities ?? {},
      skills: Array.isArray(card.skills)
        ? card.skills.map(skill => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          tags: skill.tags,
        }))
        : [],
      securityRequired: Array.isArray(card.securityRequirements)
        ? card.securityRequirements.length > 0
        : Array.isArray(card.security) ? card.security.length > 0 : false,
    }
  }

  /** List configured peers without network access. */
  function listPeers() {
    return {
      ok: true,
      peers: settings.peers.map(candidate => ({
        name: candidate.name,
        url: candidate.url,
        description: candidate.description ?? '',
      })),
    }
  }

  return { agentCard, sendMessage, getTask, cancelTask, listPeers, resolve, rpc }

  /** Normalize a task or message result into a compact summary. */
  function summarize(result, target) {
    const task = result?.task
    if (task !== undefined) {
      const state = normalizeState(task.status?.state)
      const parts = Array.isArray(task.artifacts)
        ? task.artifacts.flatMap(artifact => Array.isArray(artifact.parts) ? artifact.parts : [])
        : []
      const statusParts = Array.isArray(task.status?.message?.parts) ? task.status.message.parts : []
      const text = textOf(parts) || textOf(statusParts)
      const failed = state === 'failed' || state === 'rejected'
      return {
        ok: !failed && state !== 'unknown',
        failed,
        endpoint: target.endpoint,
        taskId: task.id,
        contextId: task.contextId,
        state,
        text,
        artifacts: Array.isArray(task.artifacts)
          ? task.artifacts.map(artifact => ({
            artifactId: artifact.artifactId,
            name: artifact.name,
            text: textOf(Array.isArray(artifact.parts) ? artifact.parts : []),
          }))
          : [],
        history: Array.isArray(task.history) ? task.history.length : 0,
        messages: Array.isArray(task.history)
          ? task.history.map(message => ({
            role: roleOf(message.role),
            text: textOf(Array.isArray(message.parts) ? message.parts : []),
          }))
          : [],
      }
    }
    const message = result?.message
    if (message !== undefined) {
      const text = textOf(Array.isArray(message.parts) ? message.parts : [])
      return {
        ok: true,
        failed: false,
        endpoint: target.endpoint,
        contextId: message.contextId,
        state: 'message',
        text,
        artifacts: [],
        history: 0,
        messages: [],
      }
    }
    return { ok: false, endpoint: target.endpoint, error: { message: 'The A2A response contained neither a task nor a message.' } }
  }
}

// ---- Helpers -------------------------------------------------------------

/** Wrap a v0.3 bare Task result into the v1.0 oneof envelope. */
function legacyTaskResult(result) {
  if (result !== null && typeof result === 'object' && result.task === undefined && typeof result.id === 'string') {
    return { task: result }
  }
  return result
}

function textOf(parts) {
  return parts
    .map((part) => {
      if (typeof part?.text === 'string') return part.text
      if (part?.kind === 'text' && typeof part.text === 'string') return part.text
      if (part?.data !== undefined) {
        try {
          return JSON.stringify(part.data)
        } catch {
          return ''
        }
      }
      return ''
    })
    .filter(text => text.length > 0)
    .join('\n\n')
}

function isTerminal(result) {
  const state = normalizeState(result?.task?.status?.state)
  return state === 'completed' || state === 'failed' || state === 'canceled' || state === 'rejected'
}

function normalizeState(value) {
  if (typeof value !== 'string') return 'unknown'
  if (value.startsWith('TASK_STATE_')) return value.slice('TASK_STATE_'.length).toLowerCase()
  return value
}

function roleOf(role) {
  if (role === 'ROLE_AGENT' || role === 'agent') return 'agent'
  if (role === 'ROLE_USER' || role === 'user') return 'user'
  return 'unknown'
}

function withTimeout(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (signal === undefined) return timeout
  return AbortSignal.any([signal, timeout])
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function stringRecord(value) {
  const out = {}
  for (const [key, entry] of Object.entries(value ?? {})) {
    if (typeof entry === 'string') out[key] = entry
  }
  return out
}
