/**
 * dsh-a2a — Agent2Agent (A2A) protocol bridge for DeepSeek Harness.
 *
 * Host half:
 *  - serves the A2A agent card and a JSON-RPC endpoint on the DSH web server;
 *  - maps each A2A context to a DSH Session and each A2A task to one turn;
 *  - registers client tools that call remote A2A agents from chat.
 *
 * The protocol surface targets A2A v1.0, with v0.3 slash-method aliases and a
 * discovery card that carries both generations' fields.
 */

import Schema from '@deepseek-ai/schemastery'
import { createA2aClient } from './lib/client.js'
import { createA2aServer } from './lib/server.js'
import { registerA2aTools } from './lib/tools.js'

/** Plugin name registered with the Loader. */
export const name = 'dsh-a2a'

/** Host services required before any route or Agent is created. */
export const inject = ['agents', 'webServer']

const Skill = Schema.object({
  id: Schema.string().required().description('Stable skill id.'),
  name: Schema.string().required().description('Human-readable skill name.'),
  description: Schema.string().default('').description('What the skill does.'),
  tags: Schema.array(Schema.string()).default([]).description('Discovery tags.'),
  examples: Schema.array(Schema.string()).default([]).description('Example prompts.'),
})

const Peer = Schema.object({
  name: Schema.string().required().description('Model-facing peer name.'),
  url: Schema.string().required().description('A2A endpoint URL.'),
  description: Schema.string().default('').description('What the peer agent is good at.'),
  token: Schema.string().default('').description('Bearer token for this peer, when it requires authentication.'),
})

/** Plugin configuration. */
export const Config = Schema.object({
  routePrefix: Schema.string().default('/a2a').description('Absolute HTTP path of the JSON-RPC endpoint.'),
  publicUrl: Schema.string().default('').description('Externally reachable base URL advertised in the agent card; defaults to the DSH web origin.'),
  authToken: Schema.string().default('').description('Require this bearer token. When empty, only loopback callers are accepted.'),
  corsOrigins: Schema.array(Schema.string()).default([]).description('Browser origins allowed to call the endpoint, for example https://client.example. Empty disables CORS; use * to allow any origin.'),
  modelProvider: Schema.string().default('').description('Model provider for A2A sessions; defaults to the deployment default.'),
  model: Schema.string().default('').description('Model for A2A sessions; defaults to the deployment default.'),
  reasoningEffort: Schema.string().default('').description('Optional reasoning effort for A2A sessions.'),
  maxTokens: Schema.natural().default(0).description('Optional per-request output token cap for A2A sessions; 0 omits it.'),
  cwd: Schema.string().default('').description('Workspace directory for A2A sessions; defaults to the DSH default workspace directory.'),
  agentPreset: Schema.string().default('').description('Agent preset for A2A sessions. Empty uses the deployment default preset, which gives callers that preset\u2019s full toolset.'),
  cardName: Schema.string().default('').description('Agent Card name.'),
  cardDescription: Schema.string().default('').description('Agent Card description.'),
  cardVersion: Schema.string().default('1.0.0').description('Agent Card version string.'),
  iconUrl: Schema.string().default('').description('Optional Agent Card icon URL; defaults to the bridge\u2019s own icon route.'),
  documentationUrl: Schema.string().default('').description('Optional Agent Card documentation URL.'),
  organization: Schema.string().default('').description('Provider organization, together with providerUrl.'),
  providerUrl: Schema.string().default('').description('Provider URL, together with organization.'),
  skills: Schema.array(Skill).default([]).description('Advertised skills; empty publishes one generic agent skill.'),
  peers: Schema.array(Peer).default([]).description('Remote A2A agents offered to chat tools and the prompt.'),
  maxTasks: Schema.natural().default(100).description('Maximum retained A2A tasks before the oldest terminal task is dropped.'),
  taskTtlSeconds: Schema.natural().default(86400).description('Retention of terminal A2A tasks, in seconds.'),
  maxBodyBytes: Schema.natural().default(1048576).description('Maximum JSON-RPC request body size in bytes.'),
  maxConcurrentTasks: Schema.natural().default(8).description('Maximum A2A tasks running at once.'),
  historyLength: Schema.natural().default(50).description('Default number of task history messages returned.'),
  agentTimeoutSeconds: Schema.natural().default(900).description('Maximum time one A2A task may run before it is canceled.'),
  clientTimeoutMs: Schema.natural().default(960000).description('Deadline for one outbound A2A client call, in milliseconds; keep it above agentTimeoutSeconds.'),
  clientToken: Schema.string().default('').description('Default bearer token for outbound calls to ad-hoc A2A endpoints.'),
  clientHeaders: Schema.dict(Schema.string()).default({}).description('Extra HTTP headers for outbound A2A calls.'),
})

/**
 * Mount the A2A server and client tools.
 * @param {object} ctx Cordis context carrying `agents` and `webServer`.
 * @param {object} config validated plugin configuration.
 */
export function apply(ctx, config) {
  const logger = ctx.logger
  if ((config.modelProvider.length > 0) !== (config.model.length > 0)) {
    logger?.warn?.('dsh-a2a: modelProvider and model should be set together; the missing one falls back to the deployment default.')
  }
  if (config.authToken.length === 0) {
    logger?.info?.('dsh-a2a: authToken is empty, so only loopback callers are accepted.')
  }
  const server = createA2aServer({ ctx, config, logger })
  ctx.effect(() => () => server.dispose())

  let endpoint
  try {
    endpoint = server.card().supportedInterfaces[0]?.url
  } catch (error) {
    logger?.warn?.(`dsh-a2a: could not advertise the endpoint: ${String(error)}`)
  }

  ctx.inject(['tools', 'systemPrompt'], (scoped) => {
    const client = createA2aClient({ config, logger })
    registerA2aTools(scoped, { config, client, endpoint })
  })

  if (endpoint !== undefined) logger?.info?.(`dsh-a2a: A2A endpoint ${endpoint}`)
}
