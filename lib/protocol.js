/**
 * A2A protocol values, wire-shape adaptation, and JSON-RPC helpers.
 *
 * The canonical in-memory shape is A2A v1.0 (ProtoJSON): PascalCase methods,
 * `TASK_STATE_*` states, unified parts, and member-presence polymorphism.
 * Requests and responses written in the v0.3 slash-method dialect are adapted
 * at the edge through the `legacy` flag carried by each task.
 */

import { randomUUID } from 'node:crypto'

/** Protocol version this bridge speaks. */
export const PROTOCOL_VERSION = '1.0'

/** A2A v1.0 method names. */
export const METHODS = {
  SEND: 'SendMessage',
  STREAM: 'SendStreamingMessage',
  GET: 'GetTask',
  LIST: 'ListTasks',
  CANCEL: 'CancelTask',
  SUBSCRIBE: 'SubscribeToTask',
  PUSH_CREATE: 'CreateTaskPushNotificationConfig',
  PUSH_GET: 'GetTaskPushNotificationConfig',
  PUSH_LIST: 'ListTaskPushNotificationConfigs',
  PUSH_DELETE: 'DeleteTaskPushNotificationConfig',
  CARD: 'GetExtendedAgentCard',
}

/** v0.3 slash-method aliases mapped onto the canonical methods. */
export const LEGACY_METHODS = {
  'message/send': METHODS.SEND,
  'message/stream': METHODS.STREAM,
  'tasks/get': METHODS.GET,
  'tasks/list': METHODS.LIST,
  'tasks/cancel': METHODS.CANCEL,
  'tasks/resubscribe': METHODS.SUBSCRIBE,
  'tasks/pushNotificationConfig/set': METHODS.PUSH_CREATE,
  'tasks/pushNotificationConfig/get': METHODS.PUSH_GET,
  'tasks/pushNotificationConfig/list': METHODS.PUSH_LIST,
  'tasks/pushNotificationConfig/delete': METHODS.PUSH_DELETE,
  'agent/getAuthenticatedExtendedCard': METHODS.CARD,
  'agent/authenticatedExtendedCard': METHODS.CARD,
}

/** Canonical task states. */
export const TASK_STATE = {
  UNSPECIFIED: 'TASK_STATE_UNSPECIFIED',
  SUBMITTED: 'TASK_STATE_SUBMITTED',
  WORKING: 'TASK_STATE_WORKING',
  COMPLETED: 'TASK_STATE_COMPLETED',
  FAILED: 'TASK_STATE_FAILED',
  CANCELED: 'TASK_STATE_CANCELED',
  REJECTED: 'TASK_STATE_REJECTED',
  INPUT_REQUIRED: 'TASK_STATE_INPUT_REQUIRED',
  AUTH_REQUIRED: 'TASK_STATE_AUTH_REQUIRED',
}

/** States after which a task accepts no further messages. */
export const TERMINAL_STATES = new Set([
  TASK_STATE.COMPLETED,
  TASK_STATE.FAILED,
  TASK_STATE.CANCELED,
  TASK_STATE.REJECTED,
])

/** States that pause a task without ending it. */
export const INTERRUPTED_STATES = new Set([
  TASK_STATE.INPUT_REQUIRED,
  TASK_STATE.AUTH_REQUIRED,
])

/** v0.3 state spellings for canonical states. */
const LEGACY_STATE = {
  [TASK_STATE.UNSPECIFIED]: 'unknown',
  [TASK_STATE.SUBMITTED]: 'submitted',
  [TASK_STATE.WORKING]: 'working',
  [TASK_STATE.COMPLETED]: 'completed',
  [TASK_STATE.FAILED]: 'failed',
  [TASK_STATE.CANCELED]: 'canceled',
  [TASK_STATE.REJECTED]: 'rejected',
  [TASK_STATE.INPUT_REQUIRED]: 'input-required',
  [TASK_STATE.AUTH_REQUIRED]: 'auth-required',
}

/** Map any accepted state spelling to the canonical state. */
export function normalizeState(value) {
  if (typeof value !== 'string') return TASK_STATE.UNSPECIFIED
  const direct = Object.values(TASK_STATE).find(state => state === value)
  if (direct !== undefined) return direct
  const legacy = Object.entries(LEGACY_STATE).find(([, legacyName]) => legacyName === value)
  return legacy?.[0] ?? TASK_STATE.UNSPECIFIED
}

/** JSON-RPC / A2A error with an explicit code. */
export class A2aError extends Error {
  /**
   * @param {number} code JSON-RPC error code.
   * @param {string} message human-readable detail.
   * @param {object} [info] google.rpc.ErrorInfo metadata.
   * @param {string} [reason] Upper-snake reason used in ErrorInfo.
   */
  constructor(code, message, info = {}, reason = 'A2A_ERROR') {
    super(message)
    this.name = 'A2aError'
    this.code = code
    this.info = info
    this.reason = reason
  }
}

/** Standard error constructors used by the server. */
export const errors = {
  parse: detail => new A2aError(-32700, `Parse error: ${detail}`, {}, 'PARSE_ERROR'),
  invalidRequest: detail => new A2aError(-32600, `Invalid request: ${detail}`, {}, 'INVALID_REQUEST'),
  methodNotFound: method => new A2aError(-32601, `Method not found: ${method}`, { method }, 'METHOD_NOT_FOUND'),
  invalidParams: detail => new A2aError(-32602, `Invalid params: ${detail}`, {}, 'INVALID_PARAMS'),
  internal: detail => new A2aError(-32603, `Internal error: ${detail}`, {}, 'INTERNAL_ERROR'),
  taskNotFound: taskId => new A2aError(-32001, `Task not found: ${taskId}`, { taskId }, 'TASK_NOT_FOUND'),
  taskNotCancelable: taskId => new A2aError(-32002, `Task cannot be canceled: ${taskId}`, { taskId }, 'TASK_NOT_CANCELABLE'),
  pushNotSupported: () => new A2aError(-32003, 'Push notifications are not supported by this agent.', {}, 'PUSH_NOTIFICATION_NOT_SUPPORTED'),
  unsupported: detail => new A2aError(-32004, `Unsupported operation: ${detail}`, {}, 'UNSUPPORTED_OPERATION'),
  contentType: detail => new A2aError(-32005, `Content type not supported: ${detail}`, {}, 'CONTENT_TYPE_NOT_SUPPORTED'),
  invalidAgentResponse: detail => new A2aError(-32006, `Invalid agent response: ${detail}`, {}, 'INVALID_AGENT_RESPONSE'),
  extendedCard: () => new A2aError(-32007, 'An extended agent card is not configured.', {}, 'EXTENDED_AGENT_CARD_NOT_CONFIGURED'),
  version: detail => new A2aError(-32009, `Protocol version not supported: ${detail}`, {}, 'VERSION_NOT_SUPPORTED'),
}

/** Build a JSON-RPC success envelope. */
export function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}

/** Build a JSON-RPC error envelope with v1.0 ErrorInfo data. */
export function rpcError(id, error) {
  const a2a = error instanceof A2aError ? error : errors.internal(error instanceof Error ? error.message : String(error))
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: a2a.code,
      message: a2a.message,
      data: [{
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: a2a.reason,
        domain: 'a2a-protocol.org',
        metadata: a2a.info,
      }],
    },
  }
}

/** ISO-8601 timestamp with millisecond precision. */
export function timestamp() {
  return new Date().toISOString()
}

/** Extract text from an assistant message's content blocks. */
export function assistantText(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

/** Extract text from a tool-result message's content blocks. */
export function toolResultText(message) {
  return assistantText(message)
}

/**
 * Parse incoming message parts into internal text parts.
 * Supports v1.0 `{text|raw|url|data}`, v0.3 `{kind:'text'|'file'|'data'}`.
 * @param {unknown} raw raw parts array.
 * @returns {{ parts: object[], textParts: { type: 'text', text: string }[] }}
 */
export function parseParts(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw errors.invalidParams('message.parts must be a non-empty array')
  const parts = []
  for (const part of raw) {
    if (part === null || typeof part !== 'object') continue
    if (typeof part.text === 'string') {
      parts.push({ type: 'text', text: part.text })
      continue
    }
    if (part.kind === 'file' && part.file && typeof part.file === 'object') {
      const file = part.file
      const name = typeof file.name === 'string' && file.name.length > 0 ? file.name : 'attachment'
      const mediaType = typeof file.mimeType === 'string' ? file.mimeType : typeof file.mediaType === 'string' ? file.mediaType : 'application/octet-stream'
      const where = typeof file.uri === 'string' ? ` at ${file.uri}` : typeof file.bytes === 'string' ? ` (inline base64 omitted)` : ''
      parts.push({ type: 'text', text: `[Attachment: ${name} (${mediaType})${where}]` })
      continue
    }
    if (typeof part.url === 'string') {
      const name = typeof part.filename === 'string' && part.filename.length > 0 ? part.filename : 'attachment'
      const mediaType = typeof part.mediaType === 'string' ? part.mediaType : 'application/octet-stream'
      parts.push({ type: 'text', text: `[Attachment: ${name} (${mediaType}) at ${part.url}]` })
      continue
    }
    if (typeof part.raw === 'string') {
      const name = typeof part.filename === 'string' && part.filename.length > 0 ? part.filename : 'attachment'
      const mediaType = typeof part.mediaType === 'string' ? part.mediaType : 'application/octet-stream'
      parts.push({ type: 'text', text: `[Binary attachment: ${name} (${mediaType}), ${part.raw.length} base64 characters]` })
      continue
    }
    if (part.data !== undefined) {
      let text
      try {
        text = JSON.stringify(part.data)
      } catch {
        text = String(part.data)
      }
      parts.push({ type: 'text', text })
      continue
    }
    if (part.kind === 'data' && part.data !== undefined) {
      parts.push({ type: 'text', text: JSON.stringify(part.data) })
    }
  }
  if (parts.length === 0) throw errors.invalidParams('message.parts contained no supported content')
  return {
    parts,
    textParts: parts.map(part => ({ type: 'text', text: part.text })),
  }
}

/**
 * Parse one incoming A2A message into internal form.
 * @param {unknown} raw wire message.
 * @returns {{ messageId: string, role: 'user'|'agent', parts: object[], contextId?: string, taskId?: string }}
 */
export function parseMessage(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw errors.invalidParams('message must be an object')
  const role = raw.role === 'ROLE_AGENT' || raw.role === 'agent' ? 'agent' : 'user'
  const { parts } = parseParts(raw.parts)
  const messageId = typeof raw.messageId === 'string' && raw.messageId.length > 0 ? raw.messageId : randomUUID()
  const message = { messageId, role, parts }
  if (typeof raw.contextId === 'string' && raw.contextId.length > 0) message.contextId = raw.contextId
  if (typeof raw.taskId === 'string' && raw.taskId.length > 0) message.taskId = raw.taskId
  return message
}

/**
 * Build an agent-authored internal message.
 * @param {string} text message text.
 * @param {{ contextId?: string, taskId?: string }} identity task identity.
 */
export function agentMessage(text, identity = {}) {
  const message = {
    messageId: randomUUID(),
    role: 'agent',
    parts: [{ type: 'text', text }],
  }
  if (identity.contextId !== undefined) message.contextId = identity.contextId
  if (identity.taskId !== undefined) message.taskId = identity.taskId
  return message
}

/** Serialize one internal part for the wire. */
export function serializePart(part, legacy) {
  if (legacy) return { kind: 'text', text: part.text }
  return { text: part.text, mediaType: 'text/plain' }
}

/** Serialize one internal message for the wire. */
export function serializeMessage(message, legacy) {
  const role = message.role === 'agent' ? (legacy ? 'agent' : 'ROLE_AGENT') : (legacy ? 'user' : 'ROLE_USER')
  const out = {
    messageId: message.messageId,
    role,
    parts: message.parts.map(part => serializePart(part, legacy)),
  }
  if (legacy) out.kind = 'message'
  if (message.contextId !== undefined) out.contextId = message.contextId
  if (message.taskId !== undefined) out.taskId = message.taskId
  return out
}

/** Serialize one internal artifact for the wire. */
export function serializeArtifact(artifact, legacy) {
  const out = {
    artifactId: artifact.artifactId,
    parts: artifact.parts.map(part => serializePart(part, legacy)),
  }
  if (artifact.name !== undefined) out.name = artifact.name
  if (artifact.description !== undefined) out.description = artifact.description
  return out
}

/** Serialize task status for the wire. */
export function serializeStatus(record, legacy) {
  const status = {
    state: legacy ? LEGACY_STATE[record.state] : record.state,
    timestamp: record.statusTimestamp,
  }
  if (record.statusMessage !== undefined) status.message = serializeMessage(record.statusMessage, legacy)
  return status
}

/**
 * Serialize one task snapshot.
 * @param {object} record internal task record.
 * @param {{ historyLength?: number, includeArtifacts?: boolean, legacy?: boolean }} options wire projection.
 */
export function serializeTask(record, options = {}) {
  const legacy = options.legacy ?? record.legacy === true
  const out = {
    id: record.id,
    contextId: record.contextId,
    status: serializeStatus(record, legacy),
  }
  if (legacy) out.kind = 'task'
  const includeArtifacts = options.includeArtifacts !== false
  if (includeArtifacts && record.artifacts.length > 0) {
    out.artifacts = record.artifacts.map(artifact => serializeArtifact(artifact, legacy))
  }
  const historyLength = options.historyLength
  if (historyLength !== 0) {
    const history = historyLength !== undefined && Number.isFinite(historyLength)
      ? record.history.slice(-Math.max(0, historyLength))
      : record.history
    if (history.length > 0) out.history = history.map(message => serializeMessage(message, legacy))
  }
  return out
}

/** Serialize a status-update stream event. */
export function serializeStatusUpdate(record, legacy) {
  const status = serializeStatus(record, legacy)
  if (legacy) {
    return {
      kind: 'status-update',
      taskId: record.id,
      contextId: record.contextId,
      status,
      final: TERMINAL_STATES.has(record.state),
    }
  }
  return {
    statusUpdate: {
      taskId: record.id,
      contextId: record.contextId,
      status,
    },
  }
}

/** Serialize an artifact-update stream event. */
export function serializeArtifactUpdate(record, artifact, append, lastChunk, legacy, overrideParts) {
  const wireArtifact = serializeArtifact(artifact, legacy)
  if (overrideParts !== undefined) wireArtifact.parts = overrideParts.map(part => serializePart(part, legacy))
  if (legacy) {
    return {
      kind: 'artifact-update',
      taskId: record.id,
      contextId: record.contextId,
      artifact: wireArtifact,
      append,
      lastChunk,
    }
  }
  return {
    artifactUpdate: {
      taskId: record.id,
      contextId: record.contextId,
      artifact: wireArtifact,
      append,
      lastChunk,
    },
  }
}

/** Test whether a serialized task or message result is terminal. */
export function resultIsTerminal(result) {
  if (result?.task?.status?.state !== undefined) {
    return TERMINAL_STATES.has(normalizeState(result.task.status.state))
  }
  return true
}
