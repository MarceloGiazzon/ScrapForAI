# ScrapForAI

Security-first Playwright exploration runner for controlled development and test sites. It runs as an
authenticated REST API (Express) that drives a real browser (Playwright) against an **allowlisted** set
of target origins, and returns structured, redacted results — screenshots, console/network evidence,
extracted data — rather than raw page control.

## Setup

```
npm install
cp .env.example .env   # then set SCRAPFORAI_API_KEY and ALLOWED_TARGET_ORIGINS
npm run dev             # http://localhost:3000
npm test                # unit tests (test/*.test.ts)
npm run typecheck
```

`.env` is gitignored and required: the server refuses to start without a `SCRAPFORAI_API_KEY` (16+
chars) and at least one `ALLOWED_TARGET_ORIGINS` entry. See `.env.example` for every tunable (timeouts,
step limits, artifact retention, etc.).

## Security model — read before changing anything here

- **Target URL allowlisting** (`src/security/validateTargetUrl.ts`): every navigation, including
  mid-routine redirects, is re-checked against `ALLOWED_TARGET_ORIGINS`. Localhost, private IPs, and
  cloud metadata endpoints are blocked unless explicitly allowlisted. Don't add a navigation path that
  skips this check.
- **Secret redaction** (`src/security/redactSecrets.ts`): credential/variable values and sensitive-
  looking DOM attributes are redacted from every response and log line.
- **Credential indirection**: exploration steps reference `valueFromCredential`/`valueFromVariable` by
  name, never by literal value — callers (including LLMs authoring routines) never see the actual
  secret.
- **`ALLOW_EVALUATE`**: the `evaluate`/`watch` steps run arbitrary in-page JavaScript. Off by default;
  enable only for local, trusted use against allowlisted dev origins.

## HTTP API

Two endpoints, both behind `Authorization: Bearer <SCRAPFORAI_API_KEY>`:

- `POST /v1/explorations/inspect-dom` — navigate to a URL and return its forms/controls/selectors/labels
  without performing any actions. Use this first to discover what's on a page.
- `POST /v1/explorations/run` — execute a multi-step routine (goto/click/fill/assert\*/extractText/
  evaluate/watch/...) and return step results plus evidence (screenshots, console, network, trace).

JSON Schemas for both request bodies (and the `run_exploration` result) are served unauthenticated —
fetch these instead of hand-writing a request body against the schema files directly:

- `GET /v1/schema/` — index of the URLs below.
- `GET /v1/schema/routine.request.json` / `GET /v1/schema/routine.result.json` — for `run_exploration`.
- `GET /v1/schema/inspect-dom.request.json` — for `inspect-dom`.

## MCP server (for AI agents/tools)

`src/mcp/server.ts` is a stdio MCP server exposing the same two capabilities as MCP tools: `inspect_dom`
and `run_exploration`. Their `inputSchema`s are the literal Zod schemas from `src/schemas/`, imported
directly rather than hand-copied, so they can never drift from what the REST API actually accepts. The
MCP server holds `SCRAPFORAI_API_KEY` itself and calls the REST API on the caller's behalf — the model
never sees the key.

This repo ships a project-scoped `.mcp.json` that registers it automatically. In Claude Code, opening
this project will prompt you to approve the `scrapforai` MCP server; approve it and both tools become
available. For any other MCP-capable client, register a stdio server with:

```
command: npx
args: ["tsx", "src/mcp/server.ts"]
```

`.env` resolution is anchored to the module's own file location, not `process.cwd()`, so the working
directory the client launches this from doesn't actually matter.

If your tool doesn't support MCP, call the REST API directly instead (see above) — the MCP server is
just a thin proxy over it.

## Tests

- `npm test` — unit tests (`test/routine-v2.test.ts`): step validation, redaction, evaluate wrapping.
- `npm run test:smoke` — `test/routine-runner.smoke.ts`, exercises frame/wait-condition helpers against
  a real headless Chromium instance.
- `test/inspect-dom.smoke.ts` spins up a local HTTP fixture and asserts `inspectDom` returns a correct
  snapshot; it isn't currently wired into an npm script, so run it directly with
  `tsx --test test/inspect-dom.smoke.ts` if you touch DOM-snapshot code.
