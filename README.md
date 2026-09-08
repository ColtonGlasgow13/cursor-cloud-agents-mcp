# cursor-cloud-agents-mcp

An MCP stdio server for the [Cursor Cloud Agents REST API v1](https://cursor.com/docs/cloud-agent/api/overview). It exposes 18 tools for agents, runs, events, models, repositories, usage, and artifacts.

The wrapper stays close to the API:

- Basic endpoint tools return Cursor's complete JSON response, including unknown fields.
- `launch_agent` awaits one `POST /v1/agents` response. It does not retry, generate identity fields, or recover conflicts with extra requests.
- `get_run_events` opens one bounded SSE stream and returns parsed events with a resume cursor. It does not fetch a run snapshot or convert stream errors into success.
- `wait_for_run` is an optional helper that polls the run endpoint every 5 seconds until a terminal status or deadline.
- Models and repositories are cached for 10 minutes. `refresh:true` bypasses the relevant cache.
- GET requests retry transient network, 429, and 5xx failures up to 3 attempts. Writes are never retried.

Cursor's v1 API is public beta. Known response schemas are used for TypeScript types and diagnostics, but a valid JSON success object is returned even when its shape changes.

## Install

All clients run:

```text
npx -y github:ColtonGlasgow13/cursor-cloud-agents-mcp
```

The repository is private, so the machine needs GitHub access. An explicit SSH package source also works:

```text
git+ssh://git@github.com/ColtonGlasgow13/cursor-cloud-agents-mcp.git
```

Create a Cursor API key at `https://cursor.com/dashboard/api`. The server reads it from `CURSOR_API_KEY` and never writes it to logs.

The CLI prints ready-to-paste configuration:

```bash
npx -y github:ColtonGlasgow13/cursor-cloud-agents-mcp print-config claude-code
# claude-code | cursor | codex | windsurf | vscode | json
```

### Claude Code

```bash
claude mcp add cursor-cloud-agents --env CURSOR_API_KEY=<YOUR_CURSOR_API_KEY> -- npx -y github:ColtonGlasgow13/cursor-cloud-agents-mcp
```

`launch_agent` may take more than a minute. Claude Code supports a per-server `timeout` in `.mcp.json`; set it to `180000` milliseconds. The parent-process `MCP_TOOL_TIMEOUT=180000` environment variable is another supported option.

### Cursor

Add this to `~/.cursor/mcp.json` or the project's `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "cursor-cloud-agents": {
      "command": "npx",
      "args": ["-y", "github:ColtonGlasgow13/cursor-cloud-agents-mcp"],
      "env": { "CURSOR_API_KEY": "<YOUR_CURSOR_API_KEY>" }
    }
  }
}
```

Cursor's MCP documentation does not specify a per-server tool-timeout key. If your installed Cursor version exposes a tool timeout, allow at least 180 seconds. Otherwise, use a client with a configurable timeout for slow launches.

### Codex CLI

```bash
codex mcp add cursor-cloud-agents --env CURSOR_API_KEY=<YOUR_CURSOR_API_KEY> -- npx -y github:ColtonGlasgow13/cursor-cloud-agents-mcp
```

Add the documented timeout to `~/.codex/config.toml`:

```toml
[mcp_servers.cursor-cloud-agents]
command = "npx"
args = ["-y", "github:ColtonGlasgow13/cursor-cloud-agents-mcp"]
tool_timeout_sec = 180

[mcp_servers.cursor-cloud-agents.env]
CURSOR_API_KEY = "<YOUR_CURSOR_API_KEY>"
```

### Other JSON clients

Use the same JSON server entry shown for Cursor. Windsurf and VS Code configuration locations vary by version.

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `CURSOR_API_KEY` | yes for server and doctor | none | Cursor API key |
| `CURSOR_API_BASE` | no | `https://api.cursor.com` | API base URL override |
| `CURSOR_MCP_LOG_LEVEL` | no | `warn` | `silent`, `error`, `warn`, `info`, or `debug`; stderr only |

Check a key without modifying agents:

```bash
CURSOR_API_KEY=crsr_... npx -y github:ColtonGlasgow13/cursor-cloud-agents-mcp doctor
```

## Tools

| Tool | API behavior | Main inputs |
| --- | --- | --- |
| `launch_agent` | Create an agent and first run | `prompt`, optional launch fields |
| `send_followup` | Create a run on an existing agent | `agentId`, `prompt`, optional run fields |
| `cancel_run` | Cancel an active run | `agentId`, `runId` |
| `archive_agent` | Archive an agent | `agentId` |
| `unarchive_agent` | Unarchive an agent | `agentId` |
| `delete_agent` | Permanently delete an agent | `agentId` |
| `get_agent` | Return an agent record | `agentId` |
| `list_agents` | Return a paginated agent envelope | filters and pagination cursor |
| `get_run` | Return a run record | `agentId`, `runId` |
| `list_runs` | Return a paginated run envelope | `agentId`, pagination cursor |
| `get_run_events` | Return one bounded SSE event batch | `agentId`, `runId`, optional cursor/window/filter |
| `wait_for_run` | Poll run status every 5 seconds | `agentId`, `runId`, optional deadline |
| `whoami` | Return API-key identity | none |
| `list_models` | Return models; cached 10 minutes | `refresh?` |
| `list_repositories` | Return repositories; cached 10 minutes | `refresh?` |
| `get_usage` | Return usage data | `agentId`, `runId?` |
| `list_artifacts` | Return the artifact envelope | `agentId` |
| `download_artifact` | Return Cursor's presigned-download response; does not fetch bytes | `agentId`, `path` |

### Event batches

`get_run_events` holds the connection for `maxWaitMs` (default 4 seconds, maximum 20 seconds) and returns:

```json
{
  "events": [{ "id": "event-id", "type": "assistant", "data": {} }],
  "eventCount": 1,
  "nextEventId": "event-id",
  "status": "RUNNING",
  "retentionSeconds": 3600
}
```

Pass `nextEventId` back as `afterEventId` to resume. Status and `interaction_update` events are included by default. Transport heartbeat events are omitted but still advance the cursor. `stream_expired` and `invalid_last_event_id` stay native Cursor errors.

### Waiting

`wait_for_run` polls raw run status every 5 seconds. It stops on `FINISHED`, `ERROR`, `CANCELLED`, or `EXPIRED`, or when `maxWaitMs` expires. The deadline covers requests and sleeps; no final request is made after it. The response contains the latest full run record plus `isTerminal`, `elapsedMs`, `pollCount`, and `pollIntervalMs`.

## Errors and retries

HTTP errors are returned as MCP `isError` results. Their structured content preserves Cursor's `status`, `code`, `message`, `requestId`, `retryAfterMs`, and response details when present. Guidance remains separate from the native message.

Only GET requests retry, with at most 3 attempts. A `Retry-After` value is never shortened. If it exceeds the 30-second retry window or does not fit a caller deadline, the original 429 is returned immediately. `POST` and `DELETE` requests are never retried because their outcome can be ambiguous after a network or server failure.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test:unit
pnpm test:contract
pnpm build
pnpm smoke
```

Integration and live scripts use the real Cursor API and are disabled unless explicitly configured. They are not part of local verification:

```bash
RUN_INTEGRATION=1 CURSOR_API_KEY=crsr_... pnpm test:integration
CURSOR_API_KEY=crsr_... pnpm live:suite
CURSOR_API_KEY=crsr_... REPO_URL=https://github.com/org/repo PROMPT='Inspect this repository' pnpm live:repo launch
```

## Out of scope

Private workers, webhooks, the local `cursor-agent` CLI, and conversation-history endpoints are outside this wrapper.

## License

MIT © Cole Glasgow
