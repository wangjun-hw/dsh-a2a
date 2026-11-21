# dsh-a2a

Agent2Agent (A2A) protocol bridge for DeepSeek Harness. It exposes DSH agents to
remote A2A clients and lets a DSH agent call remote A2A agents from chat.

The Host half registers routes on the running DSH web server and speaks A2A
v1.0 JSON-RPC. v0.3 slash-method requests (`message/send`, `tasks/get`, …) and
their smaller wire shapes are accepted as well; the discovery card carries both
generations' fields.

## Endpoints

With the default configuration the DSH web origin (for example
`http://127.0.0.1:62839`) serves:

| Path | Purpose |
|---|---|
| `/.well-known/agent-card.json` | A2A Agent Card (also `/.well-known/agent.json`) |
| `/a2a` | JSON-RPC endpoint: `POST` only, SSE for streaming methods |
| `/a2a/health` | Unauthenticated liveness and task counters |
| `/a2a/icon.svg` | The bridge icon advertised by the card |

Try it with `curl`:

```sh
curl -s http://127.0.0.1:62839/.well-known/agent-card.json
curl -s http://127.0.0.1:62839/a2a \
  -H 'content-type: application/json' -H 'a2a-version: 1.0' \
  -d '{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{"message":{"messageId":"1","role":"ROLE_USER","parts":[{"text":"Say hi"}]}}}'
```

`SendMessage` answers `{"result":{"task":{…}}}`, matching the v1.0 response
oneof; a v0.3 `message/send` answers with the task directly.

`publicUrl` and `authToken` change the advertised URL and request
authentication. With an empty `authToken`, only callers whose socket address is
loopback are accepted. Browser cross-origin calls are disabled until
`corsOrigins` names an origin; server-to-server A2A clients do not need CORS.

## Security

A2A callers drive a real DSH agent. Unless `agentPreset` names a restricted
preset, A2A sessions mount the deployment's default agent preset (the shipped
`standard` preset in Web), so callers inherit its tools: shell, file edits,
network access, subagents, and — in `standard` — plugin management. Treat the
endpoint like shell access:

- keep the DSH web server bound to loopback, or set `authToken`;
- leave `corsOrigins` empty unless a browser client must call the endpoint;
- prefer a restricted `agentPreset` (for example `minimal`) when the caller is
  not trusted with the full toolset;
- a task's turn runs with the deployment's usual sandbox and approval policy.

## Protocol surface

Supported methods:

- `SendMessage` / `message/send` — returns a `Task`; `configuration.returnImmediately`
  (v1) or `configuration.blocking: false` (v0.3) returns before the turn finishes.
- `SendStreamingMessage` / `message/stream` — SSE stream: the current `Task`,
  status updates, artifact updates, then a terminal status.
- `GetTask` / `tasks/get`, `ListTasks` / `tasks/list`, `CancelTask` / `tasks/cancel`.
- `SubscribeToTask` / `tasks/resubscribe` — live events for a running task.
- `GetExtendedAgentCard` — refused because no extended card is configured.
- Push-notification configuration methods — refused (`-32003`) because the
  server advertises `pushNotifications: false`.

Task states are the v1.0 `TASK_STATE_*` values; v0.3 requests receive the
lower-case spellings. Parts support text and JSON data; binary parts are reduced
to a text reference because attachment upload is not implemented.

## How tasks map to DSH

- One DSH Session (and Agent) is created lazily per A2A `contextId`.
- One A2A task is one DSH turn on that Agent. Committed assistant text is
  streamed as `response` artifact chunks.
- Canceling a task cancels the turn with the user cause.
- Sessions appear in the DSH session list; they use the configured model route
  (or the deployment default) and the configured working directory.
- Session creation uses the deployment's default agent preset when
  `agentPreset` is empty; set it to a restricted preset for untrusted callers.
- Tasks, contexts, and subscription buffers live in memory for the life of the
  plugin; a reload cancels running tasks and drops terminal ones.

## Client tools

When chat tools are mounted, the plugin registers:

| Tool | Purpose |
|---|---|
| `a2a_list_peers` | List configured peers. |
| `a2a_get_agent_card` | Read a remote agent card by URL or peer name. |
| `a2a_send_message` | Send a task and wait for completion, or return a task id. |
| `a2a_get_task` | Poll one remote task, including its message history. |
| `a2a_cancel_task` | Cancel one remote task. |

A system-prompt section lists configured peers and explains when to use them.

## Configuration

Override the bundle's row in the profile patch to set non-default fields:

```yaml
- id: dsh-a2a
  name: dsh-a2a
  config:
    authToken: change-me
    agentPreset: standard
    peers:
      - name: reviewer
        url: http://127.0.0.1:62839/a2a
        description: Reviews patches before merge.
```

| Field | Default | Meaning |
|---|---|---|
| `routePrefix` | `/a2a` | JSON-RPC path. |
| `publicUrl` | — | Base URL advertised in the card; defaults to the DSH web origin. |
| `authToken` | — | Bearer token required on JSON-RPC requests; empty accepts loopback only. |
| `corsOrigins` | `[]` | Browser origins allowed by CORS; empty disables CORS. |
| `modelProvider`, `model`, `reasoningEffort`, `maxTokens` | deployment default | Model route for A2A sessions. |
| `cwd` | DSH default workspace | Workspace for A2A sessions. |
| `agentPreset` | deployment default | Agent preset composed for A2A sessions. |
| `cardName`, `cardDescription`, `cardVersion` | generic DSH agent | Card identity. |
| `iconUrl`, `documentationUrl`, `organization`, `providerUrl` | — | Optional card fields. |
| `skills` | one generic skill | Advertised skills. |
| `peers` | `[]` | Remote peers offered to chat tools (`name`, `url`, `description`, `token`). |
| `maxTasks`, `taskTtlSeconds` | `100`, `86400` | Retained tasks. |
| `maxBodyBytes` | `1048576` | Request body limit. |
| `maxConcurrentTasks` | `8` | Running tasks across all contexts. |
| `historyLength` | `50` | Default history length in task responses. |
| `agentTimeoutSeconds` | `900` | Per-task deadline. |
| `clientTimeoutMs` | `960000` | Outbound call deadline. |
| `clientToken`, `clientHeaders` | — | Defaults for outbound calls. |

Turn the bundle off in **Plugins** to unregister the routes and tools; there is
no separate `enabled` field.

## Limitations

- No push notification delivery and no extended agent card.
- No file or image upload; binary and URL parts become text references.
- There is no interactive caller: the bridge instructs the agent not to ask
  questions, but a preset that exposes `ask_user_question` can still make a
  task wait until `agentTimeoutSeconds`. Use a preset without it for unattended
  callers.
- One turn at a time per context; concurrent tasks on one context queue.
- Tasks and context sessions are process-local; a plugin reload starts fresh
  contexts and cancels in-flight turns.
- A blocking `SendMessage` does not cancel its task when the HTTP client
  disconnects; cancel explicitly with `CancelTask`.
- The bridge trusts the configured bearer token only. It does not implement
  OAuth or per-caller authorization scoping; tokens live in profile
  configuration in plaintext.
- CORS is disabled by default. Add `corsOrigins` only for a browser-based A2A
  client.
