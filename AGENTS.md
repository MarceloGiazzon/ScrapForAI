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
- **Credential vault** (`src/vault/credentials/`): secrets live encrypted (AES-256-GCM) on the server and are
  referenced by id: a request passes `credentialSet: 'gam-admin'`, the server loads the fields, and steps
  use `valueFromCredential` by name. Each set is **bound to origins**: a `fill` of a vault value on any other
  origin fails with `CredentialOriginMismatch`. Values are write-only (`POST/PUT/DELETE /v1/credentials/:id`,
  bearer only; `GET` returns metadata). The MCP `run_exploration` schema has **no** `credentials` field, so a
  model never writes or sees a secret on the MCP path. Key: `SCRAPFORAI_VAULT_KEY` or `<dataDir>/vault.key`.
  *Legacy:* the REST API still accepts inline `credentials` (deprecated, logged; set
  `ALLOW_INLINE_CREDENTIALS=false` to refuse them). Inline values are redacted from outputs but are not
  origin-bound. `samples/*.json` must only contain placeholders (`test/samples-hygiene.test.ts`).
- **Target profiles** (`src/targets/`): named app+environment definitions (`targetProfile: 'app-dev'`) that supply
  the default `targetUrl` and the credential sets a run may use. A profile can never widen
  `ALLOWED_TARGET_ORIGINS`; `PUT /v1/targets/:id` needs the bearer token.
- **Routine library** (`src/library/`): a routine is data. `PUT /v1/routines/:id` stores it as an immutable,
  numbered version (`<libraryDir>/<id>/v<N>.json`, digest in `sha256`; identical content creates no new version;
  a hand-edited version fails its integrity check). Saving **lints** the steps: a literal equal to a vault value, or
  shaped like a known secret (API keys, JWT, ...), is refused with `RoutineLintError` (422). `fromJobId` saves the
  steps of a run that passed while its evidence still exists (`request.json`, credentials stripped).
  `POST /v1/routines/:id/run[?version=N]` runs a pinned or current version; the result and history carry
  `routineId`/`routineVersion`. `ROUTINE_LIBRARY_DIR` may point into a git repo.
  **Composition** (`src/library/includeExpander.ts`): a step `{ action: 'include', routineId, version? }` is expanded
  server-side before the run (the runner never sees it); expanded ids are prefixed `<includeId>.<stepId>`. Max 3
  levels, cycles refused (also at save, including a routine that includes itself), an included routine must be on the
  same target profile and not `retired`, and the versions actually used are recorded in `result.includes`. Without
  `version` the CURRENT one is used, so pin it for reproducible proof. `teardown` (routine or request) always runs
  after the steps, like `finally`: own teardown first, then those of included routines, last-included first. Its
  results are in `result.teardown` and `result.teardownStatus`; they never change `status` (the verdict of the
  steps) and a teardown failure never replaces a step failure. Steps + teardown share `MAX_STEPS_PER_JOB`.
- **Evidence retention** (`src/evidence/`): every run writes `manifest.json` (sha256 of each file and of
  `result.json`). Classes: `ephemeral` (default, `ARTIFACT_RETENTION_HOURS`), `standard`
  (`options.retention: 'standard'`, `STANDARD_RETENTION_DAYS`) and `pinned`. `POST /v1/runs/:jobId/pin`
  (bearer only; `{ reason, ref?, keepTrace? }`) moves the evidence to `<dataDir>/evidence/pinned/<jobId>/`, outside
  the artifact root so no prune reaches it. A pin verifies the run's manifest first (tampered evidence is
  refused, 409), drops `trace.zip` unless `keepTrace`, and is refused with 409 `PinnedQuotaExceeded` past
  `PINNED_EVIDENCE_MAX_MB` — pinned evidence is never deleted automatically. `GET /v1/runs/:jobId/manifest`
  re-verifies on demand. Pinned runs also keep their history entry past `HISTORY_RETENTION_DAYS`.
- **Suites and the job queue** (`src/orchestrator/`): `POST /v1/suites` (routines × `variants.credentialSets` ×
  `variants.targetProfiles`) answers **202** with a `suiteRunId` and runs in the background; `GET /v1/suites/:id[?wait=N]`
  long-polls (max 55 s, so no client timeout is hit by a long suite), `POST /v1/suites/:id/cancel` stops starting new
  runs. State is persisted in `<dataDir>/suites/<id>.json`; a suite left `running` by a dead process is closed as
  `interrupted` at startup. Each variant has a readable `variantKey` (`crud@v2/cred:gam-admin/target:qa`), the
  routine version is pinned when the suite starts, and only `active` routines run unless `statuses` says otherwise
  (the others are listed as not run). `failFast` stops at the first red run. **One verdict**: `green` (exit 0),
  `red` (1: a run failed), `infra-error` (2: a run could not execute, nothing ran, or it was cancelled); a failed
  teardown is counted in `teardownFailures` but does not change it. All runs share one pool (`MAX_PARALLEL_JOBS`) with
  priority interactive > suite > scheduled, and `INTERACTIVE_RESERVED_SLOTS` are never given to suites. **A credential
  set is never in two sessions at once** (limit `flags.maxSessionsPerCredential` of the profile, default 1): suite
  variants wait for the lock, and a synchronous run that needs a busy credential gets **409 `CredentialInUse`**.
- **Signed evidence** (`src/evidence/signature.ts`, `chain.ts`, `verify.ts`, `export.ts`): every PINNED manifest is signed
  with the installation's Ed25519 key (`<dataDir>/signing/ed25519.key`, owner-only; `keyId` = sha256 of the public key) and
  carries `chain: { sequence, previousManifestSha256 }`, so removing or editing one manifest breaks the next link, a gap in
  the sequence shows a removal, and a high-water mark (`pinned/chain.json`) shows removal of the latest ones.
  `GET /v1/evidence/chain[?deep=1]` walks it; `GET /v1/runs/:jobId/export` (pinned only) returns a .zip with the files, the
  signed manifest, `public-key.pem` and a README; `scrapforai evidence verify <folder>` checks it with no server
  (`--expected-key-id` to also prove WHO signed: a key that travels with the files only proves the bundle is self-consistent).
  Evidence pinned before signing existed is listed as `unsigned`, not trusted, and cannot be exported.
  **What a signature proves**: integrity and origin (this installation signed exactly these files). **Not** that the test was
  correct, and not anything about a machine whose private key or whole data directory is compromised. `signature.ts` and
  `verify.ts` import no configuration on purpose, so verification works anywhere.
- **Reports** (`src/reports/`): `GET /v1/runs/:jobId/report` and `GET /v1/suites/:id/report` (`?format=html|pdf&lang=en|pt|es`;
  `scrapforai report <id> --out file`) give a homologation report: application, environment, build, date, executor, routine
  and version, verdict, steps with times, failure screenshot, console/network summary, teardown warning, and a footer with the
  signing `keyId`, manifest sha256 and chain position (or an explicit "not signed / expired"). The HTML is one
  self-contained file (screenshots embedded) under a CSP without scripts; EVERYTHING from a run is escaped (`esc()`), and the
  PDF is printed by the same Chromium with every network request aborted. A suite report is refused (409) while it runs. A
  report needs the run's evidence to still exist: pin what you will report on. `render.ts`/`i18n.ts` are pure.
- **Regression vault** (`src/vault/regression/`): a fixed bug or hard scenario kept as permanent proof, one
  `<ITEM-ID>.json` per item (`REGRESSION_VAULT_DIR` may point into a git repo). An item pins a library routine
  (id + version) and two pieces of PINNED evidence: `provenRed` (the failing run) and `firstGreen` (the first
  passing run on a fixed build), each with the sha256 of its pinned manifest and the `buildId`. **Evidence cannot be
  typed in**: `PUT /v1/vault/:id` writes only the definition; `POST /v1/vault/add-from-run` (bearer) takes a run that
  FAILED, saves its routine, pins it as RED and creates the item; `POST /v1/vault/:id/confirm-green` (bearer) runs the
  same routine version and, only if it passes, pins it as `firstGreen` (still red = 409, item untouched; `firstGreen`
  is never overwritten). An item without `provenRed` needs `redNotCapturedReason`. `POST /v1/vault/:id/run` runs one
  item and records `lastRun`. A suite item `{ vault: { status?, type?, tags?, surface? } }` expands to the matching
  items (default ACTIVE); with `order: 'impact'` they are ordered by: surface touched (explicit `impact.surfaces`, or a
  changed file matching the `surfaces` globs of the target profile) > failed in its last 5 runs > severity > id, and
  every run records the reasons (`POST /v1/vault/plan` shows the order without running). `buildId` (request/suite
  field) is recorded in results and in evidence references.
- **`ALLOW_EVALUATE`**: the `evaluate`/`watch` steps run arbitrary in-page JavaScript. Off by default;
  enable only for local, trusted use against allowlisted dev origins.

## HTTP API

Core endpoints, all behind `Authorization: Bearer <SCRAPFORAI_API_KEY>`:

- `POST /v1/explorations/inspect-dom` — navigate to a URL and return its forms/controls/selectors/labels
  without performing any actions. Use this first to discover what's on a page.
- `POST /v1/explorations/run` — execute a multi-step routine (goto/click/fill/assert\*/extractText/
  evaluate/watch/...) and return step results plus evidence (screenshots, console, network, trace).
- `GET /v1/credentials[/:id]` (metadata only) and `POST|PUT|DELETE /v1/credentials/:id` (bearer only) — the
  credential vault. `POST|GET /v1/suites`, `GET /v1/suites/:id`, `POST /v1/suites/:id/cancel` — suites.
  `GET|PUT /v1/routines[/:id]`, `POST /v1/routines/:id/run` — the routine library.
  `GET /v1/targets[/:id]` and `PUT /v1/targets/:id` (bearer only) — target profiles.
  `GET /v1/runs/:jobId/{manifest,export,report}`, `GET /v1/evidence/{chain,public-key}`, `GET /v1/suites/:id/report`.
  `GET /v1/vault[/:id|/export]`, `PUT /v1/vault/:id`, `POST /v1/vault/{add-from-run,plan,:id/run,:id/confirm-green}` — regression vault.

JSON Schemas for both request bodies (and the `run_exploration` result) are served unauthenticated —
fetch these instead of hand-writing a request body against the schema files directly:

- `GET /v1/schema/` — index of the URLs below.
- `GET /v1/schema/routine.request.json` / `GET /v1/schema/routine.result.json` — for `run_exploration`.
- `GET /v1/schema/inspect-dom.request.json` — for `inspect-dom`.

## MCP server (for AI agents/tools)

`src/mcp/server.ts` is a stdio MCP server exposing the same two capabilities as MCP tools: `inspect_dom`
and `run_exploration`, plus `list_credential_sets`, `list_targets`, and the routine library tools `list_routines`, `get_routine`,
`save_routine` and `run_routine`, for suites `run_suite` (returns the id at once) and `get_suite_result`, and `get_run` (a past run by jobId), and for the regression vault `vault_list`, `vault_show`, `vault_add_from_run`, `vault_confirm_green`, `vault_run`. Their `inputSchema`s are the Zod
schemas from `src/schemas/`, imported directly rather than hand-copied, so they can never drift from what the
REST API actually accepts (`run_exploration` uses `mcpExplorationRequestSchema`: the same request minus inline
`credentials`). The
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

`.claude/skills/scrapforai/SKILL.md` is the agent-facing guide (T8.7): when to use each tool, the flow, the
GeneXus/NPDev conventions, how to read evidence and how to turn a reproduced bug into a vault item. Keep it in
sync when MCP tools or conventions change (`docs/genexus-routine-conventions.md` and `docs/npdev-testing-guide.md`
remain the detailed sources).

If your tool doesn't support MCP, call the REST API directly instead (see above) — the MCP server is
just a thin proxy over it.

## Web console

The UI (`UI_ENABLED=true`, `public/`) has History, **Vault** (items with status, severity, RED/GREEN proof links, last run, per-item
"Run", and "Run by impact": paste changed files, see the order and reasons, run the vault as a suite and open its report),
Configuration and Status. It authenticates with a session cookie, so it can only use endpoints a session may call: capturing
evidence (`add-from-run`, `confirm-green`), pinning and credentials stay bearer-only. `test/ui-vault.test.ts` guards the CSP rules.

## CLI

`npm run cli -- <command>` (or `scrapforai` once installed: `bin` → `dist/cli.js`) is a thin REST client for terminals, CI and
ledger guards: `run <routineId> [--version N] [--target id] [--credential set] [--var k=v]`, `suite <file.json|->`,
`routines list`, `runs show <jobId>`, `pin <jobId> --reason ...`, `report <id> --out file`, `evidence verify|export|chain`, `vault list|show|export|run|confirm-green` (`vault run --impact --changed-files <file|->` runs the whole vault as an impact-ordered suite). Exit codes: **0** passed, **1** a test failed,
**2** anything else (API down, bad usage, a run that could not execute, wait timeout). `--json` prints exactly one JSON
object on stdout (`cliSchema: 1`, schema in `schema/cli.output.json`); progress and human errors go to stderr. The API
key comes from `.env`, never from the command line. Fields are only ever added to the JSON; a breaking change bumps
`cliSchema`.

## Tests

- `npm test` — unit tests (`test/routine-v2.test.ts`): step validation, redaction, evaluate wrapping.
- `npm run test:smoke` — `test/routine-runner.smoke.ts` (frame/wait-condition helpers) and
  `test/credential-vault.smoke.ts` (vault secret end to end: origin binding, redaction, nothing on disk),
  `test/report-pdf.smoke.ts` (real PDFs in en/pt/es, nothing loaded from the network),
  `test/regression-flow.smoke.ts` (RED pinned -> still red -> fix -> GREEN pinned, impact-ordered vault suite),
  `test/suite-run.smoke.ts` (credential locks measured server-side, failFast, verdicts, cancel, 409 vs interactive),
  `test/routine-library.smoke.ts` (pinned versions, history tagging, saving a run without its secret), all
  against a real headless Chromium instance. Tests must set `ARTIFACT_DIR` to a temp dir: `.env` may pin it.
- `test/inspect-dom.smoke.ts` spins up a local HTTP fixture and asserts `inspectDom` returns a correct
  snapshot; it isn't currently wired into an npm script, so run it directly with
  `tsx --test test/inspect-dom.smoke.ts` if you touch DOM-snapshot code.
