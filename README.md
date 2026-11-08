# ScrapForAI

ScrapForAI is a security-first browser exploration runner for controlled development and test sites. It receives a restricted JSON scenario, runs it with Playwright, collects redacted evidence, and returns structured output for an AI development tool.

It is not a generic open-web scraper. It does not include anti-bot evasion, stored sessions, or application-specific behavior. In-page JavaScript execution is available only through the disabled-by-default `ALLOW_EVALUATE` flag for trusted local development/test targets.

## Install (end users)

1. Download `ScrapForAI-Setup-x.y.z.exe` from the release page.
2. Run it. No administrator rights are required — it installs per-user into
   `%LOCALAPPDATA%\ScrapForAI`, and bundles both Node and Chromium, so nothing else needs to
   be installed first.
3. On first launch the app generates a strong API key, writes it to `.env`, and prints it.
   **Copy it** — it is what you sign in with.
4. A browser opens at `http://127.0.0.1:3000/ui/`. Sign in with that key.

The service listens on loopback only. It is not reachable from other machines.

## Install (developers)

The native path needs **Node.js 22.13 or newer** and npm. Docker, Doppler and `cloudflared` are not needed (see [Prerequisites](#prerequisites)).

Linux / macOS:

```sh
npm ci
npx playwright install chromium      # Linux: add --with-deps to also install system libraries (asks for sudo)
cp .env.example .env
```

Windows (PowerShell):

```powershell
npm ci
npx playwright install chromium
Copy-Item .env.example .env
```

Then edit `.env`. The server **refuses to start** until you have set two things, and says so if you have not:

- `SCRAPFORAI_API_KEY` — your own key. Generate one with
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. You sign in to the UI with it.
- `ALLOWED_TARGET_ORIGINS` — the **exact origin** of the application to test: scheme + host + port, no wildcard, for example
  `http://localhost:5173`. Only listed origins can ever be opened, and a different port is a different origin.

Check the machine and the configuration, then start:

```sh
npm run doctor     # Node version, .env, browser, port, target reachable; says what to do about each problem
npm run dev        # http://localhost:3000
```

`npm run doctor` only reads: it installs nothing, asks for no privileges and never prints the key. Once the server is up:
`curl http://127.0.0.1:3000/health` answers `{"status":"ok"...}`, and `npm run typecheck` and `npm test` should pass.

## Security Model

- Every endpoint except `GET /health`, `GET /v1/schema*` and the static UI under `/ui` requires
  either `Authorization: Bearer <SCRAPFORAI_API_KEY>` or a UI session cookie.
- `ALLOWED_TARGET_ORIGINS` controls `targetUrl`, literal `goto` URLs, and main-frame redirects.
- `ALLOWED_RESOURCE_ORIGINS` controls expected external resource/API origins.
- Unexpected resource/API origins are reported in evidence for MVP.
- Screenshots, traces, DOM snapshots, and network evidence may contain sensitive data.
- `evaluate` and `watch` execute caller-provided JavaScript in the page when `ALLOW_EVALUATE=true`; keep this disabled unless the caller and target app are trusted.
- Extracted results redact credential values and sensitive keys recursively. Routine `variables` values are not treated as secrets by default.
- Credentials live in an encrypted server-side vault (AES-256-GCM; key from `SCRAPFORAI_VAULT_KEY` or `<dataDir>/vault.key`). Store a set with `PUT /v1/credentials/gam-admin` (bearer token; body `{ "boundOrigins": ["https://dev.example.com"], "values": { "loginUser": "...", "loginPassword": "..." } }`), then run with `"credentialSet": "gam-admin"` and `valueFromCredential` steps. Values are write-only, and a vault value can only be typed into its bound origins (`CredentialOriginMismatch` otherwise). The MCP `run_exploration` tool has no `credentials` field, so a model never sees a secret on that path.
- Inline `credentials` in the REST body still work for compatibility but are deprecated (logged); they are redacted from outputs but not origin-bound. Set `ALLOW_INLINE_CREDENTIALS=false` to refuse them. Files in `samples/` use placeholders only.
- Routines can be kept: `PUT /v1/routines/:id` stores an immutable version (or `fromJobId` to save a run that worked), `POST /v1/routines/:id/run?version=N` re-runs it, and the history records `routineId`/`routineVersion`. Saving refuses literal secrets. `ROUTINE_LIBRARY_DIR` can point into a git repository.
- Routines compose: a step `{ "action": "include", "routineId": "login", "version": 1 }` expands another saved routine in place (ids become `<includeId>.<stepId>`; up to 3 levels, no cycles), and a `teardown` list runs after the steps whether they passed or failed, like `finally`. Teardown results are reported apart (`teardownStatus`) and never change the run's `status`.
- Suites: `POST /v1/suites` with `{ "name": "...", "items": [{ "routineId": "crud" }], "variants": { "credentialSets": ["gam-admin", "gam-readonly"] } }` runs every saved routine once per credential set in the background and answers `202` with a `suiteRunId`. Poll `GET /v1/suites/:id?wait=30`. The result has one verdict (`green`/`red`/`infra-error`, exit code 0/1/2) and one entry per run. A credential is never logged in twice at the same time; `INTERACTIVE_RESERVED_SLOTS` keeps a slot free for ad-hoc runs.
- CLI: `npm run cli -- run <routineId>` / `suite <file.json>` / `routines list` / `runs show <jobId>` / `pin <jobId> --reason ...`. Exit code `0` passed, `1` a test failed, `2` anything else (API down, bad usage, run could not execute); add `--json` for one stable JSON object (`cliSchema: 1`) on stdout. See `docs/` and the user manual page "Credentials, routines & suites".
- Reports: `scrapforai report <jobId|suiteRunId> --out report.pdf --format pdf --lang es` (or `GET /v1/runs/:jobId/report?format=pdf&lang=pt`) produces a homologation report in English, Portuguese or Spanish: header, verdict, steps, screenshots, and the signature of the evidence. Pin the run first if you will need the report after 4 hours.
- Signed evidence: pinned runs get an Ed25519-signed manifest chained to the previous one. `scrapforai evidence export <jobId> --out proof.zip` produces a bundle (files + signed manifest + public key) that anyone can check offline with `scrapforai evidence verify <folder> --expected-key-id <id>`; `scrapforai evidence chain` checks that nothing was removed or edited. It proves integrity and origin, not that the test was right.
- Regression vault: when an agent reproduces a bug (`run_exploration` fails because the app misbehaves), `POST /v1/vault/add-from-run` keeps it as permanent proof: the routine is saved and the failing run is pinned as the RED. After the fix, `POST /v1/vault/:id/confirm-green` re-runs the same routine and, if it passes, pins that run as the first GREEN. `scrapforai vault run --impact --changed-files <file>` re-checks the whole vault with the items most likely to break first, and says why. `scrapforai vault export` gives a deterministic snapshot for the NPDev ledger guard.
- Evidence expires after `ARTIFACT_RETENTION_HOURS` (4 h) unless the run asks for `options.retention: "standard"` (`STANDARD_RETENTION_DAYS`, 30 d). To keep proof permanently, `POST /v1/runs/:jobId/pin` with `{ "reason": "...", "ref": "npdev:REG-209" }` (bearer token): the evidence moves to a pinned store that is never pruned, capped by `PINNED_EVIDENCE_MAX_MB`. Each run's `manifest.json` holds a sha256 per file, and `GET /v1/runs/:jobId/manifest` re-verifies it.
- Target profiles (`PUT /v1/targets/:id`, bearer token) name an app + environment and supply the default `targetUrl` via `"targetProfile": "app-dev"`. A profile cannot widen `ALLOWED_TARGET_ORIGINS`.
- Trace defaults to `false`; screenshots default to `onFailure`; artifact retention defaults to `4` hours.
- Cloudflare Quick Tunnel is development-only, disabled by default, and available only through the Compose `tunnel` profile.

See [docs/SECURITY.md](SECURITY.md) for the full threat model.

## Web UI

Set `UI_ENABLED=true` and open `http://127.0.0.1:<PORT>/ui/`. Three screens:

- **History** — every past run, filterable by status, scenario or free text. Click a row for
  steps, screenshots, console errors and network failures.
- **Configuration** — edit `.env` from the browser. Security-critical fields
  (`SCRAPFORAI_API_KEY`, the origin allowlists, `ALLOW_EVALUATE`, `HOST`) are shown but
  **locked**: changing them requires the bearer API key, so a UI session alone cannot widen
  the allowlist or enable arbitrary JavaScript. Most fields apply only after a restart, and
  the UI says so per field.
- **Status** — runtime, listen address, data paths, disk usage and retention.

**Authentication model:** you sign in with the API key, and the server exchanges it for an
`httpOnly; SameSite=Strict` session cookie. The key itself is never stored in `localStorage`
or in any JavaScript variable. Cookie-authenticated writes additionally require an
`X-ScrapForAI-UI: 1` header, which cross-origin pages cannot set — this is what keeps the
cookie from reintroducing CSRF.

## Run history

Run records and run evidence are stored separately, with different lifetimes:

| Store | Contents | Size per run | Retention |
|---|---|---|---|
| **Run index** | jobId, scenario, target, status, timings, counts, error | ~500 bytes | `HISTORY_RETENTION_DAYS` (90) / `HISTORY_MAX_RUNS` (5000) |
| **Evidence** | screenshots, `trace.zip`, DOM snapshots, `result.json` | 1–20 MB | `ARTIFACT_RETENTION_HOURS` (4) |

So the list of what ran stays available for months while the heavy artifacts are pruned
within hours. Opening a run whose evidence has expired shows the record with an "evidence
expired" banner rather than an error.

Both live under the per-user data directory — `%LOCALAPPDATA%\ScrapForAI` on Windows,
`~/.local/share/scrapforai` on Linux — overridable with `SCRAPFORAI_DATA_DIR`.

## Prerequisites

What you need depends on how you run it. Pick one row; nothing else is required.

| How you run it | Required | Optional |
|---|---|---|
| **Installer** (Windows, end users) | The installer. It bundles Node and Chromium. | — |
| **Native development** (Linux, macOS, Windows) | Node.js 22.13+ and npm; Chromium via `npx playwright install chromium` (Chromium, its headless shell and ffmpeg: about 0.7 GB on disk, measured on Windows; on Linux `--with-deps` also installs system packages and asks for sudo). | — |
| **Docker Compose** (below) | Docker (Docker Desktop on Windows/macOS). | Doppler to supply the variables: Compose substitutes `${VAR}` from the shell or from a `.env` file next to `docker-compose.yml`. `cloudflared` only for the Quick Tunnel profile. |

To update or remove: `npm ci` re-installs the dependencies from the lock file. The browsers live in Playwright's cache (`%LOCALAPPDATA%\ms-playwright` on Windows, `~/.cache/ms-playwright` on Linux, `~/Library/Caches/ms-playwright` on macOS); `npx playwright install chromium` fetches the build this version of Playwright needs, and older builds stay in the cache until you run `npx playwright uninstall` (this installation's browsers) or `npx playwright uninstall --all` (every installation's).

## Docker Compose with Doppler (optional)

This and "Run Locally" below are the Docker path. The native path above does not use them.

Create a Doppler project:

```text
Project: ScrapForAI
Config: dev
```

Set these secrets:

```env
NODE_ENV=development
PORT=3000
HOST=0.0.0.0
SCRAPFORAI_API_KEY=replace-with-a-strong-random-value
ALLOWED_TARGET_ORIGINS=https://dev.example.com,https://qa.example.com
ALLOWED_RESOURCE_ORIGINS=https://dev.example.com,https://qa.example.com
CORS_ALLOWED_ORIGINS=http://localhost:3000
MAX_STEPS_PER_JOB=50
JOB_TIMEOUT_MS=60000
STEP_TIMEOUT_MS=10000
MAX_REQUEST_BODY_SIZE=1mb
MAX_PARALLEL_JOBS=2
MAX_DOM_SNAPSHOT_CHARS=20000
ALLOW_EVALUATE=false
MAX_EVALUATE_SCRIPT_CHARS=4000
MAX_EVALUATE_RESULT_CHARS=20000
EVALUATE_TIMEOUT_MS=5000
MAX_WATCH_DURATION_MS=30000
MIN_WATCH_INTERVAL_MS=100
MAX_WATCH_SAMPLES=200
ARTIFACT_RETENTION_HOURS=4
ARTIFACT_DIR=/app/artifacts
LOG_LEVEL=info
PLAYWRIGHT_BROWSER=chromium
```

Configure the local directory:

```powershell
Set-Location -Path "D:\WorkSpace\ScrapForAI"
doppler login
doppler setup
```

## Run Locally

```powershell
Set-Location -Path "D:\WorkSpace\ScrapForAI"
doppler run -- docker compose up --build
```

Check health:

```powershell
Invoke-RestMethod -Method Get -Uri "http://localhost:3000/health"
```

Expected response:

```json
{
  "status": "ok",
  "service": "ScrapForAI",
  "time": "2026-06-12T00:00:00.000Z"
}
```

## Test Auth Rejection

```powershell
$Body = @{
    targetUrl = "https://dev.example.com/login"
    steps = @(
        @{ action = "goto"; url = "`$targetUrl" }
    )
} | ConvertTo-Json -Depth 10

try {
    Invoke-RestMethod -Method Post -Uri "http://localhost:3000/v1/explorations/run" -ContentType "application/json" -Body $Body
} catch {
    Write-Host "Expected auth failure: $($_.Exception.Message)"
}
```

## Generic Scenario Examples

Set your API key first:

```powershell
$ApiKey = "paste-your-doppler-scrapforai-api-key-here"
$Headers = @{ Authorization = "Bearer $ApiKey" }
```

### Login Smoke Test

```powershell
$Body = @{
    scenarioName = "login smoke test"
    targetUrl = "https://dev.example.com/login"
    options = @{
        trace = $false
        screenshots = "onFailure"
        collectDomOnFailure = $true
    }
    credentials = @{
        loginUser = "test-user"
        loginPassword = "test-password"
    }
    variables = @{
        expectedText = "Dashboard"
    }
    steps = @(
        @{ label = "open app"; action = "goto"; url = "`$targetUrl" },
        @{ label = "fill user"; action = "fill"; selector = "#username"; valueFromCredential = "loginUser" },
        @{ label = "fill password"; action = "fill"; selector = "#password"; valueFromCredential = "loginPassword" },
        @{ label = "submit"; action = "click"; selector = "button[type='submit']" },
        @{ label = "wait for shell"; action = "waitForLoadState"; state = "networkidle"; timeoutMs = 10000 },
        @{ label = "assert text"; action = "assertTextContains"; selector = "body"; text = "Dashboard" }
    )
} | ConvertTo-Json -Depth 20

Invoke-RestMethod -Method Post -Uri "http://localhost:3000/v1/explorations/run" -Headers $Headers -ContentType "application/json" -Body $Body
```

## Local AI Tool Examples

### Run a Scenario

```powershell
$ApiKey = "paste-your-doppler-scrapforai-api-key-here"
$Headers = @{ Authorization = "Bearer $ApiKey" }

$Body = @{
    scenarioName = "local AI tool smoke"
    targetUrl = "https://dev.example.com/login"
    options = @{
        trace = $false
        screenshots = "onFailure"
        collectDomOnFailure = $true
    }
    steps = @(
        @{ action = "goto"; url = "`$targetUrl" },
        @{ action = "collect"; what = @("console", "network", "url") }
    )
} | ConvertTo-Json -Depth 20

Invoke-RestMethod -Method Post -Uri "http://localhost:3000/v1/explorations/run" -Headers $Headers -ContentType "application/json" -Body $Body
```

## JSON Schemas

ScrapForAI publishes JSON Schema files generated from the Zod request and result schemas. The live endpoint is public:

```powershell
Invoke-RestMethod -Method Get -Uri "http://localhost:3000/v1/schema"
Invoke-RestMethod -Method Get -Uri "http://localhost:3000/v1/schema/routine.request.json"
Invoke-RestMethod -Method Get -Uri "http://localhost:3000/v1/schema/routine.result.json"
```

Regenerate the committed files in `schema/` with:

```powershell
npm run generate:schema
```

`npm run build` runs schema generation automatically first. The committed files reflect default env limits. The live endpoint reflects the running deployment's actual env limits.

JSON Schema covers structure, types, enums, and limits. Server-side Zod still enforces cross-field rules such as unique step IDs, earlier `waitForElapsed` references, value-source exclusivity, wait-condition exclusivity, and `ALLOW_EVALUATE` gating.

## Routine v2 Features

Routine steps support optional `id`, `frame`, `delayMs`, `waitFor`, and `afterWaitFor` fields. `waitFor` runs before the action. `afterWaitFor` runs after the action; when it waits for a response, the runner arms the response listener before the action so responses triggered by the action are not missed.

`waitFor.response` only catches future responses after the wait begins. For state that is already rendered, use a selector wait or `evaluate`. For a click or submit that triggers a response, use `afterWaitFor.response`.

`evaluate` runs a script body once and stores its JSON-safe return value under `extracted[name]`. `watch` runs a script body repeatedly over a bounded time window and stores `[{ t, value }]` samples. Both require `ALLOW_EVALUATE=true`, and both are subject to script length, timeout, sample, duration, result size, and recursive redaction limits.

### Inspect DOM Safely

Use DOM inspection before building a scenario when the local AI tool needs to discover controls, labels, and safe selectors.

```powershell
$ApiKey = "paste-your-doppler-scrapforai-api-key-here"
$Headers = @{ Authorization = "Bearer $ApiKey" }

$Body = @{
    targetUrl = "https://dev.example.com/login"
    waitUntil = "domcontentloaded"
    includeRenderedHtml = $false
    includeHiddenControls = $true
    includeConsole = $true
    includeNetwork = $false
    redactSensitiveValues = $true
} | ConvertTo-Json -Depth 20

Invoke-RestMethod -Method Post -Uri "http://localhost:3000/v1/explorations/inspect-dom" -Headers $Headers -ContentType "application/json" -Body $Body
```

`includeRenderedHtml` defaults to `false`. If it is set to `true`, the response sets `sensitiveOutput = true` and includes a warning because rendered HTML can contain sensitive hidden state even after sanitization. Keep `redactSensitiveValues = true` unless you are inspecting a controlled test page with disposable data.

### Menu Load Regression Example

This is only an example. ScrapForAI does not hardcode these selectors.

```powershell
$Body = @{
    scenarioName = "example first menu click regression"
    targetUrl = "https://dev.example.com/login"
    options = @{
        trace = $false
        screenshots = "always"
        collectDomOnFailure = $true
    }
    credentials = @{
        loginUser = "test-user"
        loginPassword = "test-password"
    }
    steps = @(
        @{ label = "open login"; action = "goto"; url = "`$targetUrl" },
        @{ label = "fill user"; action = "fill"; selector = "#username"; valueFromCredential = "loginUser" },
        @{ label = "fill password"; action = "fill"; selector = "#password"; valueFromCredential = "loginPassword" },
        @{ label = "submit"; action = "click"; selector = "button[type='submit']" },
        @{ label = "wait after login"; action = "waitForLoadState"; state = "networkidle"; timeoutMs = 10000 },
        @{ label = "click caller-provided menu"; action = "click"; selector = "#top-menu" },
        @{ label = "capture first click"; action = "screenshot"; name = "after-first-menu-click" },
        @{ label = "wait caller-provided option"; action = "waitForSelector"; selector = ".left-menu .option"; state = "visible"; timeoutMs = 5000 },
        @{ label = "collect evidence"; action = "collect"; what = @("console", "network", "domText", "url", "pageErrors") }
    )
} | ConvertTo-Json -Depth 20
```

### Form Validation

```powershell
$Body = @{
    scenarioName = "form validation"
    targetUrl = "https://dev.example.com/form"
    variables = @{
        invalidValue = "not-valid"
    }
    steps = @(
        @{ action = "goto"; url = "`$targetUrl" },
        @{ action = "fill"; selector = "[name='email']"; valueFromVariable = "invalidValue" },
        @{ action = "click"; selector = "button[type='submit']" },
        @{ action = "assertTextContains"; selector = "body"; text = "invalid" },
        @{ action = "screenshot"; name = "validation-message" }
    )
} | ConvertTo-Json -Depth 20
```

### Data Loading Check

```powershell
$Body = @{
    scenarioName = "data loading check"
    targetUrl = "https://dev.example.com/search"
    variables = @{
        searchText = "ABC123"
    }
    steps = @(
        @{ action = "goto"; url = "`$targetUrl" },
        @{ action = "fill"; selector = "[name='search']"; valueFromVariable = "searchText" },
        @{ action = "press"; selector = "[name='search']"; key = "Enter" },
        @{ action = "waitForResponse"; urlContains = "/api/search"; method = "GET"; status = 200 },
        @{ action = "waitForSelector"; selector = "[data-row]"; state = "visible" },
        @{ action = "extractText"; selector = "[data-row]"; name = "firstRowText" }
    )
} | ConvertTo-Json -Depth 20
```

## Quick Tunnel

Do not start the tunnel until these local checks work:

- `GET /health`
- `POST /v1/explorations/run` requires an API key
- URL allowlist rejection works
- invalid JSON schema rejection works

Start API plus development-only tunnel:

```powershell
Set-Location -Path "D:\WorkSpace\ScrapForAI"
doppler run -- docker compose --profile tunnel up --build
```

Find the random public URL:

```powershell
docker logs scrapforai-cloudflared-quick-tunnel
```

Quick Tunnel exposes the local API to a temporary public URL. Keep it running only while testing, never disable the ScrapForAI API key, do not send production credentials through this MVP, and only allow known development/test URLs.

## Development

From the repository root:

```powershell
npm run doctor      # is this machine ready? (Node, .env, browser, port, target)
npm run typecheck
npm test
npm run build
```

## Building the installer

Requires [Inno Setup 6](https://jrsoftware.org/isdl.php) on `PATH` (or installed in its
default location) and network access the first time, to fetch the portable Node runtime and
Chromium.

```powershell
.\installer\Build-Release.ps1 -Version 1.0.0
```

This stages a self-contained payload under `installer/staging` (app, Node, Chromium, docs),
compiles it, and prints the installer path and its SHA256. Expect roughly 250–350 MB — Chromium
dominates.

Before publishing, work through [docs/RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md).

### Portable ZIP (no install)

For a download-and-run distribution that needs no installation, no admin, and writes nothing
outside its own folder:

```powershell
.\installer\Build-Zip.ps1 -Version 1.0.0     # reuses installer/staging; run Build-Release first
```

This produces `installer/output/ScrapForAI-Portable-1.0.0.zip`. The user extracts it anywhere
and double-clicks `ScrapForAI.cmd`; it runs on the bundled Node + Chromium and keeps run
history, artifacts and `.env` under `.\data` (a `portable.txt` marker selects that behavior —
the installer omits it and uses `%LOCALAPPDATA%\ScrapForAI`). Removal is just deleting the
folder. A plain `.zip` is larger than the LZMA2 installer (Deflate vs LZMA2) — expect
~330–450 MB.

### Light vs Complete distributions

Playwright uses two Chromium builds: the **headless shell** for `headless: true` (the default)
and the **full browser** for `headless: false` (headed runs). Two distributions trade one for size:

| | Complete | Light (`-Light`) |
|---|---|---|
| Chromium bundled | shell + full | shell only |
| Headed runs (`headless:false`) | supported | forced to headless (`FORCE_HEADLESS=true`) |
| Installer `.exe` | ~238 MB | ~110 MB |
| Portable `.zip` | ~350 MB | ~163 MB |

```powershell
.\installer\Build-Release.ps1 -Version 1.1.0            # Complete .exe
.\installer\Build-Zip.ps1     -Version 1.1.0            # Complete .zip
.\installer\Build-Release.ps1 -Version 1.1.0 -Light     # Light .exe
.\installer\Build-Zip.ps1     -Version 1.1.0 -Light     # Light .zip  (run Build-Staging -Light first)
```

Pick Light for agent/automation use (always headless); Complete if you need a visible browser
for debugging routines.
