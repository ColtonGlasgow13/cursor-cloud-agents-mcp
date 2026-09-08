# CLAUDE.md

MCP (stdio) server wrapping the Cursor Cloud Agents REST API v1.

## Commands

```bash
pnpm install          # dev setup (pnpm 11, Node >= 22)
pnpm typecheck        # tsc --noEmit
pnpm test:unit        # msw-backed unit tests
pnpm test:contract    # spawns the real CLI over stdio and drives it with the MCP SDK client
pnpm build            # tsc -p tsconfig.build.json, then chmod dist/cli.js
pnpm smoke            # build + boot dist/cli.js and print its tool list
pnpm test:integration # SKIPPED unless RUN_INTEGRATION=1 and CURSOR_API_KEY are set (hits the real API)
```

## Non-negotiable rules

1. **stdout is the MCP transport.** Never `console.log` from `src/server.ts`, `src/tools/**` or
   `src/client/**`. Logging goes to stderr through `src/log.ts`. The only stdout writers are the
   `print-config`, `doctor`, `--help` and `--version` CLI paths, which never run as the server.
   The contract test runs the server with `CURSOR_MCP_LOG_LEVEL=debug` specifically to catch a leak.
2. **Never retry POST or DELETE.** Cursor v1 has no idempotency key. A retried
   `POST /v1/agents` launches a second agent; a retried `POST /v1/agents/{id}/runs` queues a second
   run. Only GETs are retried (429 / 5xx / network, 3 attempts, jittered backoff). The only
   retry-safe create is a client-supplied `agentId`, which the API answers with `409
   agent_id_conflict` — `launch_agent` catches that and returns the existing agent.
3. **Never log or echo the API key.** `redact()` in `src/log.ts` scrubs `crsr_*` and
   `Authorization` values; error messages say "check CURSOR_API_KEY", never the value.
4. **Code defensively against the beta API.** Response objects are `z.looseObject` and enum-ish
   fields are parsed as plain strings (known values live in const arrays in
   `src/client/schemas.ts`). Unknown statuses must not throw; they surface as a `warning` field.

## Layout

- `src/client/**` — the only place HTTP happens (`index.ts`), error mapping (`httpErrors.ts`),
  typed errors (`errors.ts`), budget (`rateLimiter.ts`), TTL cache, SSE drain (`sse.ts`), schemas.
- `src/tools/**` — one file per MCP tool, each exporting `<name>Input`, `run<Name>` (pure, easy to
  unit test) and `register<Name>`. `shared.ts` has `toolSuccess`/`toolFailure`/`withErrorHandling`.
- `src/server.ts` — `createServer({ client })`; `src/cli.ts` — the bin.

## Conventions

Strict TS, ESM with `.js` extensions on relative imports, named exports, object params, no `any`
(use `unknown` + zod), small single-purpose files.
