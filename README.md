# ScrapForAI

ScrapForAI is a security-first browser exploration runner for controlled development and test sites. It receives a restricted JSON scenario, runs it with Playwright, collects redacted evidence, and returns structured output for an AI development tool.

It is not a generic open-web scraper. It does not include anti-bot evasion, stored sessions, or application-specific behavior. In-page JavaScript execution is available only through the disabled-by-default `ALLOW_EVALUATE` flag for trusted local development/test targets.

## Security Model

- Every endpoint except `GET /health` and `GET /v1/schema*` requires `Authorization: Bearer <SCRAPFORAI_API_KEY>`.
- `ALLOWED_TARGET_ORIGINS` controls `targetUrl`, literal `goto` URLs, and main-frame redirects.
- `ALLOWED_RESOURCE_ORIGINS` controls expected external resource/API origins.
- Unexpected resource/API origins are reported in evidence for MVP.
- Screenshots, traces, DOM snapshots, and network evidence may contain sensitive data.
- `evaluate` and `watch` execute caller-provided JavaScript in the page when `ALLOW_EVALUATE=true`; keep this disabled unless the caller and target app are trusted.
- Extracted results redact credential values and sensitive keys recursively. Routine `variables` values are not treated as secrets by default.
- Trace defaults to `false`; screenshots default to `onFailure`; artifact retention defaults to `4` hours.
- Cloudflare Quick Tunnel is development-only, disabled by default, and available only through the Compose `tunnel` profile.

## Prerequisites

- Docker Desktop
- Doppler CLI
- Node.js LTS for local development outside Docker
- Cloudflare `cloudflared` is optional locally because Compose can run the tunnel container

## Doppler Setup

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

```powershell
Set-Location -Path "D:\WorkSpace\ScrapForAI"
npm run typecheck
npm run build
```
