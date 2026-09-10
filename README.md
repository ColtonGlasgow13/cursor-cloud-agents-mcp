# cursor-cloud-agents-mcp

This repository provides an installable Model Context Protocol (MCP) server that any MCP-compatible agent or client with local stdio support can use to launch and manage Cursor Cloud Agents. It exposes 18 tools through the [Cursor Cloud Agents REST API v1](https://cursor.com/docs/cloud-agent/api/overview).

Your MCP client starts the server as a local process. The package is not installed automatically inside the cloud agents' virtual machines.

## Prerequisites

- Node.js 22 or newer
- npm and `npx`
- Git, plus GitHub access for the package source
- An MCP-compatible agent or client with local stdio support
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

Pass either key unchanged as `CURSOR_API_KEY`. This must be a Cursor API key, not a GitHub token or a model-provider key. In every example below, replace `<YOUR_CURSOR_API_KEY>` with that key. The environment-file setup is recommended; [direct environment configuration](#pass-cursor_api_key-directly) is also supported.

## 2. Configure your MCP client

Create a dedicated private environment file before registering the server. These commands preserve an existing file:

```bash
mkdir -p "$HOME/.config/cursor-cloud-agents-mcp"
touch "$HOME/.config/cursor-cloud-agents-mcp/.env"
chmod 600 "$HOME/.config/cursor-cloud-agents-mcp/.env"
${EDITOR:-vi} "$HOME/.config/cursor-cloud-agents-mcp/.env"
```

Add the key to the file:

```dotenv
CURSOR_API_KEY='<YOUR_CURSOR_API_KEY>'
```

The server uses Node's native `.env` parser. It does not expand shell expressions such as `$HOME` or `${OTHER_VARIABLE}` inside the file, so enter literal values.

The key is stored as plaintext. On POSIX systems, `chmod 600` restricts the file to its owner. Keep the file out of Git and protect it like any other credential.

`print-config` prints configuration to stdout. It changes no files and does not read the environment file:

```bash
npx -y github:ColtonGlasgow13/cursor-cloud-agents-mcp print-config claude-code --env-file-path "$HOME/.config/cursor-cloud-agents-mcp/.env"
# claude-code | codex | cursor | vscode | windsurf | json
```

If you omit `--env-file-path`, generated snippets retain `<ABSOLUTE_PATH_TO_ENV_FILE>`. Replace that placeholder with an absolute path before saving or enabling the server. Do not use `~` in JSON or TOML because those formats do not expand it. Some generated formats include comments or a Cursor install deeplink around the configuration, so select the configuration itself rather than pasting the entire output into a JSON file.

Print the absolute path to copy into JSON or TOML:

```bash
printf '%s\n' "$HOME/.config/cursor-cloud-agents-mcp/.env"
```

Merge the server into an existing client configuration without replacing other server entries. Remove any old `CURSOR_API_KEY` value from the client's `env` block when switching to `--env-file-path`; a process environment value takes precedence over the file, even when it is empty.

### Claude Code

```bash
claude mcp add cursor-cloud-agents -- npx -y github:ColtonGlasgow13/cursor-cloud-agents-mcp --env-file-path "$HOME/.config/cursor-cloud-agents-mcp/.env"
```

Add `--scope user` to make the server available in every project. For slow launches, set this server's `timeout` in `.mcp.json` to `180000` milliseconds, or start Claude Code with `MCP_TOOL_TIMEOUT=180000`. Both timeout settings are documented in the [Claude Code MCP guide](https://code.claude.com/docs/en/mcp).

### Codex CLI

```bash
codex mcp add cursor-cloud-agents -- npx -y github:ColtonGlasgow13/cursor-cloud-agents-mcp --env-file-path "$HOME/.config/cursor-cloud-agents-mcp/.env"
```

After running that command, add `tool_timeout_sec = 180` to the existing `[mcp_servers.cursor-cloud-agents]` table in `~/.codex/config.toml`.

You can configure the same server by hand instead:

```toml
[mcp_servers.cursor-cloud-agents]
command = "npx"
args = ["-y", "github:ColtonGlasgow13/cursor-cloud-agents-mcp", "--env-file-path", "<ABSOLUTE_PATH_TO_ENV_FILE>"]
tool_timeout_sec = 180
```

Use either the add command and its existing entry or the manual TOML block. Do not append a second table with the same name. The [Codex MCP documentation](https://developers.openai.com/codex/mcp) covers these settings.

### Cursor

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
      "args": ["-y", "github:ColtonGlasgow13/cursor-cloud-agents-mcp", "--env-file-path", "<ABSOLUTE_PATH_TO_ENV_FILE>"]
    }
  }
}
```

You can use `.cursor/mcp.json` for project configuration. Open **Customize** in the Cursor sidebar and enable `cursor-cloud-agents`. Cursor starts the local process; you do not need to run the server in a separate terminal. See [Cursor's MCP setup guide](https://cursor.com/docs/mcp) for the current interface.

`launch_agent` can take more than a minute because it waits for Cursor's full create-agent response. Cursor does not document a per-server tool-timeout key. If your installed Cursor version exposes a tool timeout, allow at least 180 seconds.

### VS Code

Add this to the project's `.vscode/mcp.json`. VS Code uses a top-level `servers` object:

```json
{
  "servers": {
    "cursor-cloud-agents": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:ColtonGlasgow13/cursor-cloud-agents-mcp", "--env-file-path", "<ABSOLUTE_PATH_TO_ENV_FILE>"]
    }
  }
}
```

For user-level configuration, run **MCP: Open User Configuration** from the Command Palette and add the same server under `servers`. See [VS Code's MCP server documentation](https://code.visualstudio.com/docs/agent-customization/mcp-servers) for details.

### Windsurf

Add this entry under `mcpServers` in `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "cursor-cloud-agents": {
      "command": "npx",
      "args": ["-y", "github:ColtonGlasgow13/cursor-cloud-agents-mcp", "--env-file-path", "<ABSOLUTE_PATH_TO_ENV_FILE>"]
    }
  }
}
```

The path and wrapper object follow the [Windsurf MCP documentation](https://docs.windsurf.com/windsurf/cascade/mcp).

### Pass `CURSOR_API_KEY` directly

Direct process environment values are fully supported. Use this route instead of the `--env-file-path` entries above. When migrating an existing registration, remove its `--env-file-path` arguments and update that server rather than registering a second `cursor-cloud-agents` server. A direct value takes precedence if both methods are present, even when the direct value is empty.

Client configurations store direct values as plaintext. Use a private user-level file, keep it out of Git, and restart or re-enable the server after changing it.

`print-config --key` produces inline-key output:

```bash
npx -y github:ColtonGlasgow13/cursor-cloud-agents-mcp print-config claude-code --key '<YOUR_CURSOR_API_KEY>'
```

Passing a real key on the command line can leave it in shell history. The environment-file method avoids that exposure.

#### Claude Code with a direct key

```bash
claude mcp add cursor-cloud-agents --env CURSOR_API_KEY='<YOUR_CURSOR_API_KEY>' -- npx -y github:ColtonGlasgow13/cursor-cloud-agents-mcp
```

This stores the key in the Claude Code MCP registration. Add `--scope user` to make the registration available in every project.

#### Codex CLI with a direct key

```bash
codex mcp add cursor-cloud-agents --env CURSOR_API_KEY='<YOUR_CURSOR_API_KEY>' -- npx -y github:ColtonGlasgow13/cursor-cloud-agents-mcp
```

After running that command, add `tool_timeout_sec = 180` to the existing `[mcp_servers.cursor-cloud-agents]` table.

For a complete manual `~/.codex/config.toml` entry, use this instead of the add command:

```toml
[mcp_servers.cursor-cloud-agents]
command = "npx"
args = ["-y", "github:ColtonGlasgow13/cursor-cloud-agents-mcp"]
tool_timeout_sec = 180

[mcp_servers.cursor-cloud-agents.env]
CURSOR_API_KEY = "<YOUR_CURSOR_API_KEY>"
```

#### Cursor with a direct key

Merge this server under `mcpServers` in `~/.cursor/mcp.json`:

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

#### VS Code with a direct key

Merge this server under the top-level `servers` object in `.vscode/mcp.json`:

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

This project file contains the plaintext key, so keep it out of Git. For user-level configuration, run **MCP: Open User Configuration** from the VS Code Command Palette and place the same server under `servers`.

#### Windsurf with a direct key

Merge this server under `mcpServers` in `~/.codeium/windsurf/mcp_config.json`:

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

## 3. Verify the key without changing cloud agents

After saving the configuration, enable or restart the server in your MCP client. Confirm that the client shows 18 tools, then ask it to call only the `cursor-cloud-agents` `whoami` tool. That read-only call returns the identity associated with the key.

Run `doctor` with the environment file:

```bash
npx -y github:ColtonGlasgow13/cursor-cloud-agents-mcp doctor --env-file-path "$HOME/.config/cursor-cloud-agents-mcp/.env"
```

Or pass the key directly for this command:

```bash
CURSOR_API_KEY='<YOUR_CURSOR_API_KEY>' npx -y github:ColtonGlasgow13/cursor-cloud-agents-mcp doctor
```

Success exits with code 0 and prints JSON containing `"ok": true` plus the Cursor identity. `doctor` resolves values from the selected file and process environment as applicable; it does not read your MCP client's configuration. It calls the identity endpoint and does not create, update, or delete an agent.

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `CURSOR_API_KEY` | yes for server and doctor | none | Cursor user or service account API key |
| `CURSOR_API_BASE` | no | `https://api.cursor.com` | API base URL override |
| `CURSOR_MCP_LOG_LEVEL` | no | `warn` | `silent`, `error`, `warn`, `info`, or `debug`; stderr only |

For the default server command, `serve`, and `doctor`, the server chooses at most one file. An explicit `--env-file-path PATH` replaces the current-working-directory default and must exist; the server does not merge or fall back to `.env`. Without that flag, it reads `.env` from the current working directory when the file exists.

Values already present in the process environment then override values from the chosen file. This applies even when a process variable is an empty string. An empty or stale `CURSOR_API_KEY` passed by a client therefore shadows the file and can cause a missing-key or authentication error. Remove the old client `env` entry, save the configuration, and restart or re-enable the server.

The server uses only `CURSOR_API_KEY`, `CURSOR_API_BASE`, and `CURSOR_MCP_LOG_LEVEL` from the file. Node's native parser does not perform shell expansion. `--help`, `--version`, and `print-config` do not read an environment file.

A source checkout can use the included template:

```bash
if [ ! -e .env ]; then cp .env.example .env; fi
chmod 600 .env
${EDITOR:-vi} .env
```

In the editor, replace `<YOUR_CURSOR_API_KEY>` with your key before running the server or `doctor`.

The default server command and `doctor` load this `.env` automatically when they run from the checkout. The repository's `.gitignore` excludes `.env`; keep that rule in place.

## API behavior

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
