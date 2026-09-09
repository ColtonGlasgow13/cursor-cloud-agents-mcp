# cursor-cloud-agents-mcp

This repository provides an installable Model Context Protocol (MCP) stdio server for Cursor Agent. After you add it to Cursor, Cursor Agent can invoke 18 tools that launch and manage Cursor Cloud Agents through the [Cursor Cloud Agents REST API v1](https://cursor.com/docs/cloud-agent/api/overview).

Your MCP client starts the server as a local process. The package is not installed automatically inside the cloud agents' virtual machines.

## Prerequisites

- Node.js 22 or newer
- npm and `npx`
- Git, plus GitHub access for the package source
- Cursor for the setup below, or another supported MCP client
- A Cursor API key

This repository is private during prelaunch. Configure GitHub authentication on the machine so `npx` can fetch it. The package source remains:

```text
github:ColtonGlasgow13/cursor-cloud-agents-mcp
```

An explicit SSH source also works:

```text
git+ssh://git@github.com/ColtonGlasgow13/cursor-cloud-agents-mcp.git
```

## 1. Create a Cursor API key

The [Cloud Agents API](https://cursor.com/docs/cloud-agent/api/endpoints) accepts either of these keys:

- A user API key from your personal Cursor account. Create one at [cursor.com/dashboard/api](https://cursor.com/dashboard/api).
- A service account API key. [Service accounts](https://cursor.com/docs/account/enterprise/service-accounts) are available on Enterprise. A Cursor admin creates one under **Dashboard > Settings > API Keys > Service Accounts > New Service Account** and must copy the generated key immediately. For the service account to use repositories, the team also needs a team-level Cursor GitHub app integration.

Pass either key unchanged as `CURSOR_API_KEY`. This must be a Cursor API key, not a GitHub token or a model-provider key. In every example below, replace `<YOUR_CURSOR_API_KEY>` with that key.

The server reads the environment variables passed to its process. It does not load `.env` files automatically, so set the key in the MCP client configuration below.

## 2. Configure Cursor

Create the personal MCP configuration directory if needed:

```bash
mkdir -p ~/.cursor
```

Add this server under `mcpServers` in `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "cursor-cloud-agents": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:ColtonGlasgow13/cursor-cloud-agents-mcp"],
      "env": {
        "CURSOR_API_KEY": "<YOUR_CURSOR_API_KEY>"
      }
    }
  }
}
```

Replace `<YOUR_CURSOR_API_KEY>`, including the angle brackets, with your key while keeping the JSON quotes. Do this before saving or enabling the server. If the file already contains other `mcpServers`, merge the `cursor-cloud-agents` entry into that object instead of replacing the file.

The personal file keeps the key out of a project checkout. You can use `.cursor/mcp.json` for project configuration, but do not commit a file that contains the key.

Open **Customize** in the Cursor sidebar and enable `cursor-cloud-agents`. Cursor starts the local process; you do not need to run the server in a separate terminal. Confirm that Cursor shows 18 tools, then ask it to call only the `cursor-cloud-agents` `whoami` tool. That read-only call returns the identity associated with the key. See [Cursor's MCP setup guide](https://cursor.com/docs/mcp) for the current interface.

`launch_agent` can take more than a minute because it waits for Cursor's full create-agent response. Cursor does not document a per-server tool-timeout key. If your installed Cursor version exposes a tool timeout, allow at least 180 seconds.

## 3. Verify the key without changing cloud agents

Run `doctor` from a terminal. The environment assignment applies only to this command:

```bash
CURSOR_API_KEY='<YOUR_CURSOR_API_KEY>' npx -y github:ColtonGlasgow13/cursor-cloud-agents-mcp doctor
```

Success exits with code 0 and prints JSON containing `"ok": true` plus the Cursor identity. `doctor` checks the terminal environment; it does not read `~/.cursor/mcp.json`. It calls the identity endpoint and does not create, update, or delete an agent.

## Other MCP clients

### Generate a configuration snippet

`print-config` prints configuration to stdout. It changes no files and needs no API key:

```bash
npx -y github:ColtonGlasgow13/cursor-cloud-agents-mcp print-config cursor
# cursor | claude-code | codex | windsurf | vscode | json
```

Without a `--key` argument, the output retains `<YOUR_CURSOR_API_KEY>`. Replace that placeholder before saving or enabling the server. Some formats include comments or a Cursor install deeplink around the configuration, so do not paste the entire output into a JSON file without selecting the JSON object.

### Claude Code

```bash
claude mcp add cursor-cloud-agents --env CURSOR_API_KEY='<YOUR_CURSOR_API_KEY>' -- npx -y github:ColtonGlasgow13/cursor-cloud-agents-mcp
```

Add `--scope user` to make the server available in every project. For slow launches, set this server's `timeout` in `.mcp.json` to `180000` milliseconds, or start Claude Code with `MCP_TOOL_TIMEOUT=180000`. Both timeout settings are documented in the [Claude Code MCP guide](https://code.claude.com/docs/en/mcp).

### Codex CLI

```bash
codex mcp add cursor-cloud-agents --env CURSOR_API_KEY='<YOUR_CURSOR_API_KEY>' -- npx -y github:ColtonGlasgow13/cursor-cloud-agents-mcp
```

After running that command, add `tool_timeout_sec = 180` to the existing `[mcp_servers.cursor-cloud-agents]` table in `~/.codex/config.toml`.

You can configure the same server by hand instead:

```toml
[mcp_servers.cursor-cloud-agents]
command = "npx"
args = ["-y", "github:ColtonGlasgow13/cursor-cloud-agents-mcp"]
tool_timeout_sec = 180

[mcp_servers.cursor-cloud-agents.env]
CURSOR_API_KEY = "<YOUR_CURSOR_API_KEY>"
```

Use either the add command and its existing entry or the manual TOML block. Do not append a second table with the same name. The [Codex MCP documentation](https://developers.openai.com/codex/mcp) covers these settings.

### VS Code

Add this to the project's `.vscode/mcp.json`. VS Code uses a top-level `servers` object:

```json
{
  "servers": {
    "cursor-cloud-agents": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:ColtonGlasgow13/cursor-cloud-agents-mcp"],
      "env": {
        "CURSOR_API_KEY": "<YOUR_CURSOR_API_KEY>"
      }
    }
  }
}
```

Do not commit this project file with a real key. See [VS Code's MCP server documentation](https://code.visualstudio.com/docs/agent-customization/mcp-servers) for user-level and input-variable alternatives.

### Windsurf

Add this entry under `mcpServers` in `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "cursor-cloud-agents": {
      "command": "npx",
      "args": ["-y", "github:ColtonGlasgow13/cursor-cloud-agents-mcp"],
      "env": {
        "CURSOR_API_KEY": "<YOUR_CURSOR_API_KEY>"
      }
    }
  }
}
```

The path and wrapper object follow the [Windsurf MCP documentation](https://docs.windsurf.com/windsurf/cascade/mcp).

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `CURSOR_API_KEY` | yes for server and doctor | none | Cursor user or service account API key |
| `CURSOR_API_BASE` | no | `https://api.cursor.com` | API base URL override |
| `CURSOR_MCP_LOG_LEVEL` | no | `warn` | `silent`, `error`, `warn`, `info`, or `debug`; stderr only |

The server reads the environment variables passed to its process. It does not load `.env` files automatically. `.env.example` documents the variables, but copying it to `.env` does not configure the server unless another tool loads that file into the process environment.

If the server reports that `CURSOR_API_KEY` is missing, check where the failing process gets its environment. For Cursor, check the `env` object in `mcp.json`, save it, and restart or re-enable the server. For `doctor`, set the key in the terminal command as shown above.

## API behavior

The wrapper stays close to Cursor's API:

- Basic endpoint tools return Cursor's complete JSON response, including unknown fields.
- `launch_agent` awaits one `POST /v1/agents` response. It does not retry, generate identity fields, or recover conflicts with extra requests.
- `get_run_events` opens one bounded SSE stream and returns parsed events with a resume cursor. It does not fetch a run snapshot or convert stream errors into success.
- `wait_for_run` is an optional helper that polls the run endpoint every 5 seconds until a terminal status or deadline.
- Models and repositories are cached for 10 minutes. `refresh:true` bypasses the relevant cache.
- GET requests retry transient network, 429, and 5xx failures up to 3 attempts. Writes are never retried.

Cursor's v1 API is public beta. Known response schemas are used for TypeScript types and diagnostics, but a valid JSON success object is returned even when its shape changes.

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

Only GET requests retry, with at most 3 attempts. A `Retry-After` value is never shortened. If it exceeds the 30-second maximum retry delay or does not fit a caller deadline, the original 429 is returned immediately. `POST` and `DELETE` requests are never retried because their outcome can be ambiguous after a network or server failure.

## Development

Use Node.js 22 or newer and pnpm 11. Clone the source before running the development commands:

```bash
git clone git@github.com:ColtonGlasgow13/cursor-cloud-agents-mcp.git
cd cursor-cloud-agents-mcp
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
