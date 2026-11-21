/**
 * Model-facing A2A tools and peer guidance.
 *
 * Tools are registered in the scope that resolved `tools` and `systemPrompt`.
 * Each call acts for the Agent that dispatched it only in the sense of the
 * caller's cancellation signal; A2A requests carry no DSH session identity.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { errorChain } from '@deepseek-ai/dsh-llm'

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }

const AGENT_HELP =
  'Configured peer name, an A2A endpoint URL, or an agent-card URL.'

/** Render any JSON result as one text block for the model. */
function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** Present a concise generic call card. */
function presentCall(title, kind, rawInput) {
  return { card: 'generic', title, kind, ...(rawInput === undefined ? {} : { rawInput }) }
}

/** Convert a thrown failure into a model-readable result. */
function failure(error) {
  return { ok: false, error: { message: errorChain(error) } }
}

/**
 * Register the A2A tools and the peer system-prompt section.
 * @param {object} ctx context that resolved `tools` and `systemPrompt`.
 * @param {{ config: object, client: object, endpoint?: string }} options plugin settings, client, and advertised endpoint.
 */
export function registerA2aTools(ctx, { config, client, endpoint }) {
  const agentHelp = endpoint === undefined ? AGENT_HELP : `${AGENT_HELP} This deployment answers at ${endpoint}.`
  const peers = Array.isArray(config.peers) ? config.peers : []
  const peerLines = peers.map(peer => `- ${peer.name}: ${peer.url}${peer.description ? ` — ${peer.description}` : ''}`)
  const guidance = peerLines.length > 0
    ? `A2A interoperability: these remote agents are available for delegation.\n${peerLines.join('\n')}\n`
      + 'Use a2a_send_message with the peer name (or any A2A endpoint URL) to send a task and read the reply. '
      + 'Use a2a_get_agent_card to inspect an unknown agent, a2a_get_task to poll a long-running task, '
      + 'and a2a_cancel_task to stop one.'
    : 'A2A interoperability: when the user gives an A2A endpoint URL, use a2a_send_message to delegate a task '
      + 'to that remote agent, a2a_get_agent_card to inspect it, and a2a_get_task or a2a_cancel_task to manage a task.'

  ctx.systemPrompt.section({
    name: 'tool:a2a',
    order: 3250,
    text: () => ctx.tools.get('a2a_send_message') === undefined ? '' : guidance,
  })

  ctx.tools.register(defineTool({
    name: 'a2a_list_peers',
    description: 'List the A2A agents configured as peers for this deployment, with their names and endpoint URLs.',
    parameters: {},
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    isConcurrencySafe: () => true,
    async execute() {
      return client.listPeers()
    },
    presentCall: () => presentCall('List A2A peers', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'a2a_get_agent_card',
    description: `Read a remote A2A agent card to learn its name, skills, interfaces, and capabilities. ${agentHelp}`,
    parameters: {
      agent: { type: 'string', required: true, description: agentHelp },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      try {
        return await client.agentCard({ agent: args.agent, signal: exec.signal })
      } catch (error) {
        return failure(error)
      }
    },
    presentCall: args => presentCall('Read A2A agent card', 'read', args.agent),
  }))

  ctx.tools.register(defineTool({
    name: 'a2a_send_message',
    description:
      'Send a text task to a remote A2A agent and return its task state, reply text, and artifacts. '
      + 'By default the call waits until the remote task reaches a terminal state; set wait to false to return '
      + 'immediately with a task id to poll using a2a_get_task. ' + agentHelp,
    parameters: {
      agent: { type: 'string', required: true, description: agentHelp },
      message: { type: 'string', required: true, description: 'The complete task or question to send.' },
      wait: {
        type: 'boolean',
        description: 'Wait for the remote task to finish; defaults to true. Set false for long tasks, then poll a2a_get_task.',
      },
      taskId: {
        type: 'string',
        description: 'Continue an existing remote task instead of starting a new one.',
      },
      contextId: {
        type: 'string',
        description: 'Remote context id for a multi-turn conversation; omit to let the remote agent create one.',
      },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    async execute(args, exec) {
      try {
        return await client.sendMessage({
          agent: args.agent,
          message: args.message,
          wait: args.wait !== false,
          taskId: args.taskId,
          contextId: args.contextId,
          signal: exec.signal,
        })
      } catch (error) {
        return failure(error)
      }
    },
    presentCall: args => presentCall('Send A2A message', 'other', args.agent),
  }))

  ctx.tools.register(defineTool({
    name: 'a2a_get_task',
    description: 'Read the current state, artifacts, and message history of a remote A2A task.',
    parameters: {
      agent: { type: 'string', required: true, description: agentHelp },
      taskId: { type: 'string', required: true, description: 'Remote task id returned by a2a_send_message.' },
      historyLength: {
        type: 'integer',
        description: 'Maximum number of recent task messages to return; 0 omits them.',
      },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      try {
        return await client.getTask({
          agent: args.agent,
          taskId: args.taskId,
          historyLength: args.historyLength,
          signal: exec.signal,
        })
      } catch (error) {
        return failure(error)
      }
    },
    presentCall: args => presentCall('Get A2A task', 'read', args.taskId),
  }))

  ctx.tools.register(defineTool({
    name: 'a2a_cancel_task',
    description: 'Cancel a running remote A2A task and return its resulting state.',
    parameters: {
      agent: { type: 'string', required: true, description: agentHelp },
      taskId: { type: 'string', required: true, description: 'Remote task id to cancel.' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      try {
        return await client.cancelTask({ agent: args.agent, taskId: args.taskId, signal: exec.signal })
      } catch (error) {
        return failure(error)
      }
    },
    presentCall: args => presentCall('Cancel A2A task', 'other', args.taskId),
  }))
}
