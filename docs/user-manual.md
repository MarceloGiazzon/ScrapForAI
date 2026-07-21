# ScrapForAI User Manual

Product version: 1.0.0  
Manual version: 1.0  
Last updated: 2026-06-14

## Table of contents

1. [What ScrapForAI is](#what-scrapforai-is)
2. [What ScrapForAI is not](#what-scrapforai-is-not)
3. [Who should use ScrapForAI](#who-should-use-scrapforai)
4. [Core concepts](#core-concepts)
5. [Architecture overview](#architecture-overview)
6. [Security model](#security-model)
7. [Prerequisites](#prerequisites)
8. [Installation](#installation)
9. [Configuration](#configuration)
10. [Running ScrapForAI](#running-scrapforai)
11. [API authentication](#api-authentication)
12. [Endpoint reference](#endpoint-reference)
13. [Routine request guide](#routine-request-guide)
14. [Step-by-step first run](#step-by-step-first-run)
15. [Practical examples](#practical-examples)
16. [DOM inspection guide](#dom-inspection-guide)
17. [Artifacts and evidence](#artifacts-and-evidence)
18. [JSON schemas](#json-schemas)
19. [Docker and tunnel usage](#docker-and-tunnel-usage)
20. [Development workflow](#development-workflow)
21. [Troubleshooting](#troubleshooting)
22. [Operational checklist](#operational-checklist)
23. [Glossary](#glossary)

## What ScrapForAI is

ScrapForAI is a security-first browser exploration runner for controlled development and test websites. It exposes an HTTP API that accepts a restricted JSON routine, opens a browser with Playwright, performs the requested steps, collects useful evidence, redacts known secrets, and returns a structured result that an AI development tool or automation client can consume.

Use it when you need an automated agent to inspect, click through, validate, or collect evidence from a web application in a predictable and controlled way.

Typical jobs include:

- Opening a development or QA URL.
- Filling a login form with disposable test credentials.
- Clicking menus, buttons, links, tabs, and form controls.
- Waiting for page loads, selectors, URLs, or network responses.
- Asserting that text, visibility, enabled state, count, or URL conditions are correct.
- Taking screenshots on failure or at named checkpoints.
- Collecting console, network, page error, URL, and DOM text evidence.
- Extracting text or attributes into a structured response.
- Inspecting a page DOM to discover safe selectors before writing a scenario.

ScrapForAI is designed as a bounded exploration tool for trusted environments. Its strongest value is giving an AI tool enough browser context to debug or verify a web application without giving it unlimited scraping capability.

## What ScrapForAI is not

ScrapForAI is not a generic open-web scraper.

It does not provide:

- Anti-bot evasion.
- CAPTCHA bypassing.
- Stored browser sessions.
- Credential vaulting.
- Site-specific scraping logic.
- Unlimited JavaScript execution.
- Open navigation to arbitrary websites.
- Production data extraction guarantees.

The service intentionally restricts target origins, resource origins, request structure, timeouts, payload sizes, and parallel jobs. The default configuration is conservative because screenshots, DOM snapshots, network evidence, traces, and extracted values can contain sensitive information.

## Who should use ScrapForAI

ScrapForAI is useful for:

- Developers who want an AI assistant to reproduce UI bugs in local, dev, or QA environments.
- QA engineers who need repeatable browser smoke checks with structured evidence.
- Platform engineers who want a small browser runner with explicit security boundaries.
- AI tool builders who need a controlled API for web app inspection and interaction.
- Support engineers who need reproducible evidence from test systems without giving broad browsing access.

ScrapForAI should be used by people who understand the target application, control or have permission to test it, and can configure a strict allowlist of target origins.

Avoid using ScrapForAI against:

- Public websites you do not control.
- Production systems containing real customer data.
- Applications whose terms prohibit automated access.
- Any system where screenshots, traces, or DOM text could expose sensitive data you cannot safely store.

## Core concepts

### Routine

A routine is the JSON request sent to `POST /v1/explorations/run`. It contains:

- A `targetUrl`.
- Optional metadata such as `scenarioName` and `caller`.
- Optional `credentials` and `variables`.
- Execution `options`.
- An ordered list of `steps`.

### Step

A step is one browser action or assertion. Examples include `goto`, `fill`, `click`, `waitForSelector`, `assertTextContains`, `screenshot`, `collect`, and `extractText`.

Steps execute in order. When a step fails, the routine stops and the result is returned with `status: "failed"`.

### Evidence

Evidence is diagnostic data collected while the routine runs. It can include:

- Screenshots.
- Playwright trace path.
- Console messages.
- Console errors.
- Page errors.
- Network events.
- Network failures.
- Unexpected external requests.
- DOM text snapshot.
- Final URL.

### Artifact

An artifact is a file written to the configured artifact directory. Typical artifacts are:

- `result.json`
- `screenshots/*.png`
- `trace.zip`

### Allowlist

An allowlist is a configured list of origins that ScrapForAI is allowed to visit or expect. The primary allowlist is `ALLOWED_TARGET_ORIGINS`, which controls the main target URL, literal `goto` URLs, and main-frame redirects.

### DOM inspection

DOM inspection is a separate endpoint that opens a target page and returns forms, controls, selectors, visible text, and optional console or network data. Use it to discover stable selectors before writing a routine.

## Architecture overview

ScrapForAI is a Node.js and TypeScript service built on:

- Express for HTTP routing.
- Playwright for browser automation.
- Zod for request validation.
- Pino for structured logging.
- Helmet, CORS, rate limiting, and bearer-token authentication for API protection.
- Docker with the official Playwright image for consistent browser runtime.

High-level flow:

1. A client sends a JSON request to ScrapForAI.
2. Express authenticates the request unless it is `GET /health` or `GET /v1/schema*`.
3. Zod validates the request structure and cross-field rules.
4. The target URL is checked against `ALLOWED_TARGET_ORIGINS`.
5. Playwright opens a browser context.
6. Steps run in order.
7. Evidence collectors record console, network, page errors, screenshots, and trace data.
8. Known secrets are redacted from results.
9. A structured JSON result is returned and also saved as an artifact.

## Security model

Security is central to ScrapForAI. Configure it carefully before connecting any AI tool.

### Public endpoints

These endpoints do not require API authentication:

- `GET /health`
- `GET /v1/schema`
- `GET /v1/schema/routine.request.json`
- `GET /v1/schema/routine.result.json`

### Protected endpoints

These endpoints require:

```http
Authorization: Bearer <SCRAPFORAI_API_KEY>
```

Protected endpoints:

- `POST /v1/explorations/run`
- `POST /v1/explorations/inspect-dom`

### Target origin restrictions

`ALLOWED_TARGET_ORIGINS` controls:

- The initial `targetUrl`.
- Literal URLs used by `goto` steps.
- Main-frame redirects.

Only origins in this list are allowed. If a target or redirect is not allowed, the request fails.

Example:

```env
ALLOWED_TARGET_ORIGINS=https://dev.example.com,https://qa.example.com
```

The origin includes scheme, host, and optional port. Paths are ignored when the service normalizes the origin.

### Resource origin reporting

`ALLOWED_RESOURCE_ORIGINS` controls expected external resources or API origins. Unexpected external resource origins are reported in evidence so the caller can inspect suspicious or accidental external traffic.

Example:

```env
ALLOWED_RESOURCE_ORIGINS=https://dev.example.com,https://api-dev.example.com
```

### Secret redaction

ScrapForAI redacts:

- The configured `SCRAPFORAI_API_KEY`.
- Values supplied under `credentials`.
- Sensitive keys and values detected recursively in result structures.
- Authorization and cookie headers in logs.

Routine `variables` are not treated as secrets by default. Put passwords, tokens, and other sensitive values in `credentials`, not `variables`.

### JavaScript execution

The `evaluate` and `watch` steps execute caller-provided JavaScript inside the page. They are disabled by default.

Keep this setting disabled unless all of these are true:

- The caller is trusted.
- The target is a controlled development or test system.
- The data in the browser is safe for local diagnostic use.
- You understand that scripts can read and mutate page state.

Enable only for local trusted use:

```env
ALLOW_EVALUATE=true
```

### Artifacts can contain sensitive data

Screenshots, traces, DOM text snapshots, rendered HTML, and network evidence may expose application data. Store artifacts locally, keep retention short, and avoid production data.

Default retention is 4 hours:

```env
ARTIFACT_RETENTION_HOURS=4
```

## Prerequisites

Recommended runtime:

- Docker Desktop.
- Doppler CLI for secret management.
- Node.js LTS for local development outside Docker.
- npm.

Optional:

- Cloudflare `cloudflared`, if you want a temporary development tunnel. The Docker Compose file can run `cloudflared` for you through the `tunnel` profile.

## Installation

You can run ScrapForAI in two ways:

- Docker Compose, recommended for normal use.
- Local Node.js, useful for development.

### Option 1: Docker Compose installation

1. Open PowerShell.

2. Go to the project folder:

```powershell
Set-Location -Path "D:\WorkSpace\ScrapForAI"
```

3. Install and configure Doppler:

```powershell
doppler login
doppler setup
```

4. Build and start the API:

```powershell
doppler run -- docker compose up --build
```

5. Verify health:

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

### Option 2: Local Node.js installation

1. Open PowerShell.

2. Go to the project folder:

```powershell
Set-Location -Path "D:\WorkSpace\ScrapForAI"
```

3. Install dependencies:

```powershell
npm ci
```

4. Create a local `.env` file from `.env.example` and edit values:

```powershell
Copy-Item .env.example .env
```

5. Install Playwright browser dependencies if needed:

```powershell
npx playwright install
```

6. Start the development server:

```powershell
npm run dev
```

7. In another PowerShell window, verify health:

```powershell
Invoke-RestMethod -Method Get -Uri "http://localhost:3000/health"
```

## Configuration

ScrapForAI reads configuration from environment variables. In Docker Compose, these are passed to the container. In local development, `.env` is loaded by the application.

### Required variables

| Variable | Required | Example | Purpose |
| --- | --- | --- | --- |
| `SCRAPFORAI_API_KEY` | Yes | `use-a-long-random-secret` | Bearer token required for protected endpoints. Must be at least 16 characters. |
| `ALLOWED_TARGET_ORIGINS` | Yes | `https://dev.example.com,https://qa.example.com` | Origins ScrapForAI may visit as target URLs and main-frame redirects. Must contain at least one origin. |

### Common server variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | Runtime mode: `development`, `test`, or `production`. |
| `PORT` | `3000` | HTTP port inside the app/container. |
| `HOST` | `0.0.0.0` | Network interface to bind. |
| `LOG_LEVEL` | `info` | Pino log level. |
| `MAX_REQUEST_BODY_SIZE` | `1mb` | Maximum JSON request size accepted by Express. |
| `CORS_ALLOWED_ORIGINS` | empty list | Browser origins allowed by CORS. Non-browser clients are not affected. |

### Browser and job limits

| Variable | Default | Purpose |
| --- | --- | --- |
| `PLAYWRIGHT_BROWSER` | `chromium` | Browser engine: `chromium`, `firefox`, or `webkit`. |
| `MAX_STEPS_PER_JOB` | `50` | Maximum steps in one routine. |
| `MAX_PARALLEL_JOBS` | `2` | Maximum concurrent exploration or inspection jobs. |
| `JOB_TIMEOUT_MS` | `60000` | Overall timeout for a routine. |
| `STEP_TIMEOUT_MS` | `10000` | Maximum timeout for most step actions. |
| `MAX_DOM_SNAPSHOT_CHARS` | `20000` | Maximum DOM text or rendered HTML snapshot length. |

### Evaluate and watch limits

| Variable | Default | Purpose |
| --- | --- | --- |
| `ALLOW_EVALUATE` | `false` | Enables `evaluate` and `watch` steps when true. |
| `MAX_EVALUATE_SCRIPT_CHARS` | `4000` | Maximum JavaScript script length. |
| `MAX_EVALUATE_RESULT_CHARS` | `20000` | Maximum serialized result length before truncation. |
| `EVALUATE_TIMEOUT_MS` | `5000` | Timeout for one script evaluation. |
| `MAX_WATCH_DURATION_MS` | `30000` | Maximum watch duration. |
| `MIN_WATCH_INTERVAL_MS` | `100` | Minimum watch sampling interval. |
| `MAX_WATCH_SAMPLES` | `200` | Maximum watch samples. |

### Artifact variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `ARTIFACT_DIR` | `/app/artifacts` | Directory where job artifacts are saved. In Compose this maps to `./artifacts`. |
| `ARTIFACT_RETENTION_HOURS` | `4` | Artifact folders older than this are pruned when new jobs create an artifact store. |

### Example `.env`

```env
NODE_ENV=development
PORT=3000
HOST=0.0.0.0

SCRAPFORAI_API_KEY=replace-with-a-strong-random-value

ALLOWED_TARGET_ORIGINS=https://dev.example.com,https://qa.example.com
ALLOWED_RESOURCE_ORIGINS=https://dev.example.com,https://qa.example.com,https://api-dev.example.com
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

## Running ScrapForAI

### Start with Docker Compose

```powershell
Set-Location -Path "D:\WorkSpace\ScrapForAI"
doppler run -- docker compose up --build
```

The Compose file binds the API to:

```text
http://localhost:3000
```

The host mapping is restricted to `127.0.0.1:3000:3000`, so the service is exposed locally by default.

### Start for local development

```powershell
Set-Location -Path "D:\WorkSpace\ScrapForAI"
npm run dev
```

### Start compiled production code locally

```powershell
Set-Location -Path "D:\WorkSpace\ScrapForAI"
npm run build
npm start
```

## API authentication

Protected API calls require a bearer token.

PowerShell header setup:

```powershell
$ApiKey = "paste-your-scrapforai-api-key-here"
$Headers = @{ Authorization = "Bearer $ApiKey" }
```

curl header setup:

```bash
API_KEY="paste-your-scrapforai-api-key-here"
curl -H "Authorization: Bearer $API_KEY" http://localhost:3000/v1/schema
```

The schema endpoint is public, but using the same header style for all calls is convenient.

Expected unauthorized behavior:

- Missing header: `401 Unauthorized`.
- Wrong API key: `401 Unauthorized`.
- Protected endpoint without bearer token: `401 Unauthorized`.

## Endpoint reference

### GET /health

Checks whether the service is running.

Authentication: not required.

Request:

```powershell
Invoke-RestMethod -Method Get -Uri "http://localhost:3000/health"
```

Response:

```json
{
  "status": "ok",
  "service": "ScrapForAI",
  "time": "2026-06-12T00:00:00.000Z"
}
```

### GET /v1/schema

Returns links to the public request and result JSON schemas.

Authentication: not required.

Request:

```powershell
Invoke-RestMethod -Method Get -Uri "http://localhost:3000/v1/schema"
```

Response:

```json
{
  "routineRequest": "/v1/schema/routine.request.json",
  "routineResult": "/v1/schema/routine.result.json"
}
```

### GET /v1/schema/routine.request.json

Returns the JSON Schema for exploration routine requests.

Authentication: not required.

Request:

```powershell
Invoke-RestMethod -Method Get -Uri "http://localhost:3000/v1/schema/routine.request.json"
```

### GET /v1/schema/routine.result.json

Returns the JSON Schema for exploration routine results.

Authentication: not required.

Request:

```powershell
Invoke-RestMethod -Method Get -Uri "http://localhost:3000/v1/schema/routine.result.json"
```

### POST /v1/explorations/run

Runs a browser exploration routine.

Authentication: required.

Request:

```powershell
$Body = @{
    scenarioName = "basic page check"
    targetUrl = "https://dev.example.com"
    options = @{
        trace = $false
        screenshots = "onFailure"
        collectDomOnFailure = $true
    }
    steps = @(
        @{ action = "goto"; url = "`$targetUrl" },
        @{ action = "assertTextContains"; selector = "body"; text = "Welcome" },
        @{ action = "collect"; what = @("console", "network", "url") }
    )
} | ConvertTo-Json -Depth 20

Invoke-RestMethod `
    -Method Post `
    -Uri "http://localhost:3000/v1/explorations/run" `
    -Headers $Headers `
    -ContentType "application/json" `
    -Body $Body
```

Success status:

- HTTP `200` when the routine passes.

Failure status:

- HTTP `500` when a valid routine runs but fails.
- HTTP `400` when the request is invalid or a URL is not allowed.
- HTTP `401` when authentication fails.
- HTTP `429` when too many jobs are already running.

### POST /v1/explorations/inspect-dom

Inspects the target page and returns controls, forms, selectors, text, and optional diagnostic evidence.

Authentication: required.

Request:

```powershell
$Body = @{
    targetUrl = "https://dev.example.com/login"
    waitUntil = "domcontentloaded"
    includeRenderedHtml = $false
    includeHiddenControls = $true
    includeConsole = $true
    includeNetwork = $false
    redactSensitiveValues = $true
} | ConvertTo-Json -Depth 20

Invoke-RestMethod `
    -Method Post `
    -Uri "http://localhost:3000/v1/explorations/inspect-dom" `
    -Headers $Headers `
    -ContentType "application/json" `
    -Body $Body
```

## Routine request guide

### Minimal routine

```json
{
  "targetUrl": "https://dev.example.com",
  "steps": [
    {
      "action": "goto",
      "url": "$targetUrl"
    }
  ]
}
```

### Full routine structure

```json
{
  "scenarioName": "login smoke test",
  "targetUrl": "https://dev.example.com/login",
  "credentials": {
    "loginUser": "test-user",
    "loginPassword": "test-password"
  },
  "variables": {
    "expectedText": "Dashboard"
  },
  "caller": {
    "correlationId": "ticket-1234",
    "source": "local-ai-tool",
    "metadata": {
      "branch": "feature/login-fix"
    }
  },
  "options": {
    "headless": true,
    "trace": false,
    "screenshots": "onFailure",
    "collectDomOnFailure": true
  },
  "steps": [
    {
      "label": "open login",
      "action": "goto",
      "url": "$targetUrl"
    }
  ]
}
```

### Top-level fields

| Field | Required | Description |
| --- | --- | --- |
| `scenarioName` | No | Human-readable routine name, up to 160 characters. |
| `targetUrl` | Yes | Initial target URL. Must match `ALLOWED_TARGET_ORIGINS`. |
| `credentials` | No | Secret values used by steps. Values are redacted from results. |
| `variables` | No | Non-secret reusable values used by steps. |
| `caller` | No | Optional metadata about the caller. |
| `options` | No | Runtime options. Defaults are applied when omitted. |
| `steps` | Yes | Ordered list of actions and assertions. |

### Options

| Option | Default | Description |
| --- | --- | --- |
| `headless` | `true` | Runs browser without UI when true. |
| `trace` | `false` | Saves a Playwright trace ZIP when true. |
| `screenshots` | `onFailure` | `off`, `onFailure`, or `always`. |
| `collectDomOnFailure` | `false` | Captures DOM text when a step fails. |
| `viewport` | `{ width: 1366, height: 768 }` | Browser viewport size, e.g. `{ "width": 390, "height": 844 }` for a mobile-sized run. |

### Common step fields

Every step can include these optional fields:

| Field | Description |
| --- | --- |
| `id` | Unique step ID. Required if another step uses `waitForElapsed` with this step. |
| `label` | Short human-readable label. |
| `description` | Longer description. |
| `frame` | Targets an iframe by name, URL fragment, or index. |
| `delayMs` | Waits before the step action. |
| `waitFor` | Wait condition executed before the action. |
| `afterWaitFor` | Wait condition executed after the action. Response waits are armed before the action. |

### Frame targeting

Use `frame` when the control is inside an iframe.

By frame name:

```json
{
  "action": "click",
  "frame": { "name": "payment-frame" },
  "selector": "button[type='submit']"
}
```

By frame URL fragment:

```json
{
  "action": "fill",
  "frame": { "urlContains": "/embedded/search" },
  "selector": "[name='q']",
  "value": "ABC123"
}
```

By frame index:

```json
{
  "action": "assertVisible",
  "frame": { "index": 1 },
  "selector": ".loaded"
}
```

If the frame is not found, ScrapForAI falls back to the main frame.

### Wait conditions

`waitFor` and `afterWaitFor` support exactly one condition:

- `selector`
- `response`
- `loadState`
- `urlContains`

Selector wait:

```json
{
  "action": "click",
  "selector": "#open-menu",
  "afterWaitFor": {
    "selector": ".menu-item",
    "state": "visible",
    "timeoutMs": 5000
  }
}
```

Response wait:

```json
{
  "action": "click",
  "selector": "button[type='submit']",
  "afterWaitFor": {
    "response": {
      "urlContains": "/api/login",
      "status": 200
    },
    "timeoutMs": 10000
  }
}
```

Load state wait:

```json
{
  "action": "goto",
  "url": "$targetUrl",
  "afterWaitFor": {
    "loadState": "networkidle",
    "timeoutMs": 10000
  }
}
```

URL wait:

```json
{
  "action": "click",
  "selector": "a[href='/dashboard']",
  "afterWaitFor": {
    "urlContains": "/dashboard",
    "timeoutMs": 10000
  }
}
```

Use `afterWaitFor.response` for responses triggered by the action, because ScrapForAI arms the listener before it performs the action.

### Value sources

Some steps need a value, such as `fill` and `selectOption`. Exactly one value source is required:

- `value`
- `valueFromCredential`
- `valueFromVariable`

Literal value:

```json
{
  "action": "fill",
  "selector": "[name='search']",
  "value": "ABC123"
}
```

Credential value:

```json
{
  "action": "fill",
  "selector": "#password",
  "valueFromCredential": "loginPassword"
}
```

Variable value:

```json
{
  "action": "fill",
  "selector": "[name='query']",
  "valueFromVariable": "searchText"
}
```

### Supported actions

| Action | Purpose | Key fields |
| --- | --- | --- |
| `goto` | Navigate to `$targetUrl` or an allowed literal URL. | `url`, `timeoutMs` |
| `reload` | Reload current page. | `timeoutMs` |
| `waitForLoadState` | Wait for `domcontentloaded`, `load`, or `networkidle`. | `state`, `timeoutMs` |
| `waitForUrlContains` | Wait until current URL contains text. | `value`, `timeoutMs` |
| `waitForTimeout` | Wait for a fixed timeout. | `timeoutMs` |
| `fill` | Fill an input-like control. | `selector`, one value source |
| `click` | Click an element. | `selector`, `timeoutMs` |
| `doubleClick` | Double-click an element. | `selector`, `timeoutMs` |
| `hover` | Hover over an element. | `selector`, `timeoutMs` |
| `press` | Press a keyboard key on an element. | `selector`, `key`, `timeoutMs` |
| `selectOption` | Select an option value. | `selector`, one value source |
| `check` | Check a checkbox or radio. | `selector`, `timeoutMs` |
| `uncheck` | Uncheck a checkbox. | `selector`, `timeoutMs` |
| `waitForSelector` | Wait for selector state. | `selector`, `state`, `timeoutMs` |
| `waitForResponse` | Wait for network response. | `urlContains`, `method`, `status`, `timeoutMs` |
| `assertVisible` | Fail unless selector is visible. | `selector`, `timeoutMs` |
| `assertHidden` | Fail unless selector is hidden. | `selector`, `timeoutMs` |
| `assertEnabled` | Fail unless selector is enabled. | `selector`, `timeoutMs` |
| `assertDisabled` | Fail unless selector is disabled. | `selector`, `timeoutMs` |
| `assertTextContains` | Fail unless selector text contains expected text. | `selector`, `text`, `timeoutMs` |
| `assertUrlContains` | Fail unless current URL contains text. | `value` |
| `assertCount` | Fail unless selector count matches condition. | `selector`, `operator`, `count` |
| `screenshot` | Save a named screenshot. | `name` |
| `collect` | Collect selected evidence. | `what` |
| `extractText` | Save selector inner text to `extracted`. | `selector`, `name`, `timeoutMs` |
| `extractAttribute` | Save an attribute to `extracted`. | `selector`, `attribute`, `name`, `timeoutMs` |
| `evaluate` | Run page JavaScript and save result. | `name`, `script` |
| `watch` | Sample page JavaScript repeatedly. | `name`, `script`, `intervalMs`, `durationMs` |
| `waitForElapsed` | Ensure a minimum elapsed time since an earlier step. | `sinceStepId`, `minElapsedMs`, `timeoutMs` |
| `setViewportSize` | Resize the browser viewport mid-run. | `width`, `height` |

### Collect action

`collect.what` can include:

- `console`
- `network`
- `domText`
- `url`
- `pageErrors`

Example:

```json
{
  "action": "collect",
  "what": ["console", "network", "domText", "url", "pageErrors"]
}
```

Console, network, and page error collectors are registered for the job. The collect step mainly controls extra snapshots such as DOM text and final URL.

### Assertion operators

`assertCount` supports:

- `=`
- `!=`
- `>`
- `>=`
- `<`
- `<=`

Example:

```json
{
  "action": "assertCount",
  "selector": "[data-row]",
  "operator": ">=",
  "count": 1
}
```

### waitForElapsed

Use `waitForElapsed` when the application requires a minimum time gap between actions.

```json
[
  {
    "id": "clicked-send",
    "action": "click",
    "selector": "#send-code"
  },
  {
    "action": "waitForElapsed",
    "sinceStepId": "clicked-send",
    "minElapsedMs": 3000,
    "timeoutMs": 5000
  },
  {
    "action": "click",
    "selector": "#resend-code"
  }
]
```

The `sinceStepId` must reference an earlier step ID.

### setViewportSize

Use `setViewportSize` to resize the browser mid-run, e.g. to check a responsive layout after starting at desktop size. The `options.viewport` setting controls the size at job start; this step changes it for subsequent steps.

```json
[
  {
    "action": "goto",
    "url": "$targetUrl"
  },
  {
    "action": "screenshot",
    "name": "desktop"
  },
  {
    "action": "setViewportSize",
    "width": 390,
    "height": 844
  },
  {
    "action": "screenshot",
    "name": "mobile"
  }
]
```

## Step-by-step first run

This walkthrough assumes:

- ScrapForAI is running at `http://localhost:3000`.
- Your API key is configured.
- `https://dev.example.com` is in `ALLOWED_TARGET_ORIGINS`.

### Step 1: Confirm the service is up

```powershell
Invoke-RestMethod -Method Get -Uri "http://localhost:3000/health"
```

You should receive `status: "ok"`.

### Step 2: Set your API key header

```powershell
$ApiKey = "paste-your-scrapforai-api-key-here"
$Headers = @{ Authorization = "Bearer $ApiKey" }
```

### Step 3: Inspect the login page

```powershell
$InspectBody = @{
    targetUrl = "https://dev.example.com/login"
    includeHiddenControls = $true
    includeConsole = $true
    includeNetwork = $false
    redactSensitiveValues = $true
} | ConvertTo-Json -Depth 20

$Inspection = Invoke-RestMethod `
    -Method Post `
    -Uri "http://localhost:3000/v1/explorations/inspect-dom" `
    -Headers $Headers `
    -ContentType "application/json" `
    -Body $InspectBody

$Inspection.visibleControls | Select-Object index, tag, id, name, type, text, labelContext
```

Use the returned `selectors` values to choose stable selectors.

### Step 4: Build a login routine

```powershell
$RunBody = @{
    scenarioName = "first login smoke"
    targetUrl = "https://dev.example.com/login"
    credentials = @{
        loginUser = "test-user"
        loginPassword = "test-password"
    }
    options = @{
        trace = $false
        screenshots = "onFailure"
        collectDomOnFailure = $true
    }
    steps = @(
        @{ label = "open login"; action = "goto"; url = "`$targetUrl" },
        @{ label = "fill user"; action = "fill"; selector = "#username"; valueFromCredential = "loginUser" },
        @{ label = "fill password"; action = "fill"; selector = "#password"; valueFromCredential = "loginPassword" },
        @{
            label = "submit"
            action = "click"
            selector = "button[type='submit']"
            afterWaitFor = @{
                urlContains = "/dashboard"
                timeoutMs = 10000
            }
        },
        @{ label = "assert dashboard"; action = "assertTextContains"; selector = "body"; text = "Dashboard" },
        @{ label = "collect diagnostics"; action = "collect"; what = @("console", "network", "url", "pageErrors") }
    )
} | ConvertTo-Json -Depth 30
```

### Step 5: Run the routine

```powershell
$Result = Invoke-RestMethod `
    -Method Post `
    -Uri "http://localhost:3000/v1/explorations/run" `
    -Headers $Headers `
    -ContentType "application/json" `
    -Body $RunBody

$Result.status
$Result.jobId
$Result.evidence.screenshots
```

### Step 6: Read the result

Important fields:

- `status`: `passed` or `failed`.
- `jobId`: artifact folder name.
- `failedStepIndex`: index of the failed step when failed.
- `error`: high-level error when failed.
- `steps`: per-step status and timings.
- `extracted`: values saved by extract/evaluate/watch steps.
- `evidence`: diagnostic data.

### Step 7: Inspect artifacts

With Docker Compose, artifacts are written under:

```text
D:\WorkSpace\ScrapForAI\artifacts
```

For job `job_abc123`, inspect:

```text
artifacts/job_abc123/result.json
artifacts/job_abc123/screenshots/failure.png
artifacts/job_abc123/trace.zip
```

Trace exists only when `options.trace` is true.

## Practical examples

### Example 1: Login smoke test

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

### Example 2: Form validation

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

### Example 3: Search and data loading

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

After running, read:

```powershell
$Result.extracted.firstRowText
```

### Example 4: Menu load regression

```powershell
$Body = @{
    scenarioName = "first menu click regression"
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
        @{ label = "click menu"; action = "click"; selector = "#top-menu" },
        @{ label = "capture first click"; action = "screenshot"; name = "after-first-menu-click" },
        @{ label = "wait option"; action = "waitForSelector"; selector = ".left-menu .option"; state = "visible"; timeoutMs = 5000 },
        @{ label = "collect evidence"; action = "collect"; what = @("console", "network", "domText", "url", "pageErrors") }
    )
} | ConvertTo-Json -Depth 20
```

### Example 5: Capture trace for a hard failure

```powershell
$Body = @{
    scenarioName = "trace checkout failure"
    targetUrl = "https://dev.example.com/checkout"
    options = @{
        trace = $true
        screenshots = "always"
        collectDomOnFailure = $true
    }
    steps = @(
        @{ action = "goto"; url = "`$targetUrl" },
        @{ action = "click"; selector = "#place-order" },
        @{ action = "waitForResponse"; urlContains = "/api/orders"; method = "POST"; status = 201; timeoutMs = 10000 },
        @{ action = "assertTextContains"; selector = "body"; text = "Order confirmed" }
    )
} | ConvertTo-Json -Depth 20
```

The result includes `evidence.tracePath` when trace is enabled.

### Example 6: Extract an attribute

```powershell
$Body = @{
    scenarioName = "download link check"
    targetUrl = "https://dev.example.com/reports"
    steps = @(
        @{ action = "goto"; url = "`$targetUrl" },
        @{ action = "waitForSelector"; selector = "a.download"; state = "visible" },
        @{ action = "extractAttribute"; selector = "a.download"; attribute = "href"; name = "downloadHref" },
        @{ action = "assertVisible"; selector = "a.download" }
    )
} | ConvertTo-Json -Depth 20
```

### Example 7: Evaluate page state, trusted local only

Requires:

```env
ALLOW_EVALUATE=true
```

Routine:

```powershell
$Body = @{
    scenarioName = "cart state debug"
    targetUrl = "https://dev.example.com/cart"
    steps = @(
        @{ action = "goto"; url = "`$targetUrl" },
        @{
            action = "evaluate"
            name = "cartSummary"
            script = "return { itemCount: document.querySelectorAll('[data-cart-item]').length, url: location.href };"
        }
    )
} | ConvertTo-Json -Depth 20
```

### Example 8: Watch changing UI state, trusted local only

Requires:

```env
ALLOW_EVALUATE=true
```

Routine:

```powershell
$Body = @{
    scenarioName = "progress watcher"
    targetUrl = "https://dev.example.com/import"
    steps = @(
        @{ action = "goto"; url = "`$targetUrl" },
        @{ action = "click"; selector = "#start-import" },
        @{
            action = "watch"
            name = "progressSamples"
            intervalMs = 500
            durationMs = 5000
            script = "return document.querySelector('[data-progress]')?.textContent ?? '';"
        }
    )
} | ConvertTo-Json -Depth 20
```

### Example 9: Use curl instead of PowerShell

```bash
curl -X POST "http://localhost:3000/v1/explorations/run" \
  -H "Authorization: Bearer $SCRAPFORAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "scenarioName": "curl smoke",
    "targetUrl": "https://dev.example.com",
    "steps": [
      { "action": "goto", "url": "$targetUrl" },
      { "action": "assertTextContains", "selector": "body", "text": "Welcome" }
    ]
  }'
```

## DOM inspection guide

Use DOM inspection before building a routine when you do not know the page selectors.

### Basic inspection

```powershell
$Body = @{
    targetUrl = "https://dev.example.com/login"
    waitUntil = "domcontentloaded"
    includeRenderedHtml = $false
    includeHiddenControls = $true
    includeConsole = $true
    includeNetwork = $false
    redactSensitiveValues = $true
} | ConvertTo-Json -Depth 20

$Inspection = Invoke-RestMethod `
    -Method Post `
    -Uri "http://localhost:3000/v1/explorations/inspect-dom" `
    -Headers $Headers `
    -ContentType "application/json" `
    -Body $Body
```

### Important response fields

| Field | Description |
| --- | --- |
| `status` | `passed` or `failed`. |
| `targetUrl` | Normalized target URL. |
| `finalUrl` | URL after navigation. |
| `title` | Page title. |
| `bodyText` | Truncated body text. |
| `forms` | Form metadata and related control indexes. |
| `visibleControls` | Controls that appear visible. |
| `allControls` | Visible and hidden controls when requested. |
| `consoleMessages` | Browser console messages when enabled. |
| `pageErrors` | Page-level errors. |
| `network` | Network events when enabled. |
| `renderedHtml` | Optional rendered HTML. Sensitive output. |
| `sensitiveOutput` | True when rendered HTML was requested. |
| `warning` | Warning about sensitive output when applicable. |

### Control fields

Each control can include:

- `index`
- `tag`
- `id`
- `name`
- `type`
- `role`
- `className`
- `visible`
- `disabled`
- `readonly`
- `text`
- `labelContext`
- `attrs`
- `selectors`
- `rect`

### Selector selection advice

Prefer stable selectors in this order:

1. Unique `id`.
2. `data-testid`, if present in `attrs`.
3. Named input selectors such as `input[name="email"]`.
4. Role or accessible label selectors only if you convert them into supported CSS selectors for ScrapForAI.
5. Class selectors only when they are stable and not generated.

Avoid:

- Deep generated CSS paths.
- Selectors based on unstable layout.
- Hidden controls unless you intentionally need them.
- Text that changes by locale or user role.

### Rendered HTML caution

`includeRenderedHtml` defaults to `false`. If set to `true`, the response includes `sensitiveOutput: true` and a warning. Rendered HTML can contain hidden application state even after sanitization.

Use this only when:

- DOM controls and body text are not enough.
- You are inspecting a controlled test page.
- You are not handling real production secrets.

## Artifacts and evidence

### Artifact layout

Each job gets its own folder:

```text
artifacts/
  job_<id>/
    result.json
    screenshots/
      failure.png
      custom-name.png
    trace.zip
```

### Screenshot behavior

Controlled by `options.screenshots`:

| Value | Behavior |
| --- | --- |
| `off` | No screenshots are saved. |
| `onFailure` | Failure screenshot is saved when a step fails. Named screenshot steps also save when screenshots are not off. |
| `always` | Named screenshots save, and failure screenshot saves on failure. |

### Trace behavior

Set:

```json
{
  "options": {
    "trace": true
  }
}
```

When enabled, ScrapForAI saves a Playwright trace to:

```text
artifacts/job_<id>/trace.zip
```

### Result file

The API response is also saved to:

```text
artifacts/job_<id>/result.json
```

### Evidence object

Result evidence includes:

```json
{
  "screenshots": [],
  "tracePath": "artifacts/job_abc123/trace.zip",
  "console": [],
  "consoleErrors": [],
  "pageErrors": [],
  "network": [],
  "networkFailures": [],
  "unexpectedExternalRequests": [],
  "domTextSnapshot": "text...",
  "finalUrl": "https://dev.example.com/dashboard"
}
```

### Artifact retention

Old artifact folders are pruned when a new artifact store is created. The cutoff is controlled by:

```env
ARTIFACT_RETENTION_HOURS=4
```

## JSON schemas

ScrapForAI publishes live JSON schemas:

```powershell
Invoke-RestMethod -Method Get -Uri "http://localhost:3000/v1/schema"
Invoke-RestMethod -Method Get -Uri "http://localhost:3000/v1/schema/routine.request.json"
Invoke-RestMethod -Method Get -Uri "http://localhost:3000/v1/schema/routine.result.json"
```

The committed schemas are in:

```text
schema/routine.request.json
schema/routine.result.json
```

Regenerate them:

```powershell
npm run generate:schema
```

Build also regenerates schemas first:

```powershell
npm run build
```

The live schema reflects the running environment limits. The committed schema reflects the defaults at generation time.

Server-side validation also enforces cross-field rules that are not fully captured by JSON Schema, including:

- Unique step IDs.
- `waitForElapsed.sinceStepId` must point to an earlier step.
- Exactly one value source for value-based steps.
- Exactly one wait condition in `waitFor` and `afterWaitFor`.
- `evaluate` and `watch` require `ALLOW_EVALUATE=true`.

## Docker and tunnel usage

### Docker service

The Compose service is named:

```text
scrapforai-api
```

It maps:

```text
127.0.0.1:3000 -> container port 3000
./artifacts -> /app/artifacts
```

Start:

```powershell
doppler run -- docker compose up --build
```

Stop:

```powershell
docker compose down
```

View logs:

```powershell
docker logs scrapforai-api
```

### Development-only Cloudflare Quick Tunnel

Do not start a tunnel until these checks work locally:

- `GET /health`.
- Protected endpoints reject missing API keys.
- Target URL allowlist rejection works.
- Invalid JSON schema rejection works.

Start API plus tunnel:

```powershell
doppler run -- docker compose --profile tunnel up --build
```

Find the temporary public URL:

```powershell
docker logs scrapforai-cloudflared-quick-tunnel
```

Important rules:

- Use the tunnel only for development.
- Keep the API key enabled.
- Do not send production credentials through the tunnel.
- Keep `ALLOWED_TARGET_ORIGINS` narrow.
- Stop the tunnel when finished.

## Development workflow

### Typecheck

```powershell
npm run typecheck
```

### Build

```powershell
npm run build
```

### Run tests

```powershell
npm test
```

### Run smoke tests

```powershell
npm run test:smoke
```

### Run all tests

```powershell
npm run test:all
```

### Start dev server

```powershell
npm run dev
```

## Troubleshooting

### Health endpoint fails

Check:

- Is the container or dev server running?
- Is port `3000` already in use?
- Did environment validation fail during startup?
- Are Docker Desktop and Playwright image available?

Useful commands:

```powershell
docker logs scrapforai-api
docker compose ps
```

### Protected endpoint returns 401

Check:

- Header is present.
- Header format is exactly `Authorization: Bearer <key>`.
- API key matches `SCRAPFORAI_API_KEY`.
- API key is at least 16 characters.

PowerShell example:

```powershell
$Headers = @{ Authorization = "Bearer $ApiKey" }
```

### Request returns 400 ValidationError

Check:

- JSON body is valid.
- Required fields exist.
- `targetUrl` is a valid URL.
- Step action names are spelled correctly.
- `steps` is not empty and does not exceed `MAX_STEPS_PER_JOB`.
- Value-based steps include exactly one of `value`, `valueFromCredential`, or `valueFromVariable`.
- Wait conditions include exactly one condition.

The response includes details:

```json
{
  "error": {
    "type": "ValidationError",
    "message": "Invalid exploration request",
    "details": [
      {
        "path": "steps.0.selector",
        "message": "Invalid input"
      }
    ]
  }
}
```

### URL is rejected

Check:

- The URL origin is listed in `ALLOWED_TARGET_ORIGINS`.
- The scheme matches. `http://` and `https://` are different origins.
- The port matches. `http://localhost:3000` and `http://localhost:5173` are different origins.
- Redirects stay on allowed origins.

Example:

```env
ALLOWED_TARGET_ORIGINS=http://localhost:5173,https://dev.example.com
```

### Routine returns 429 TooManyRequests

The number of active jobs reached `MAX_PARALLEL_JOBS`.

Fix options:

- Wait for current jobs to finish.
- Increase `MAX_PARALLEL_JOBS`.
- Reduce job duration.
- Reduce client concurrency.

### Step times out

Check:

- The selector is correct.
- The element is inside an iframe and needs `frame`.
- The page is still loading.
- The app needs a more precise `waitFor` or `afterWaitFor`.
- `STEP_TIMEOUT_MS` is too low for the environment.

Use DOM inspection to find selectors and a screenshot on failure to see page state.

### waitForResponse misses a response

Use `afterWaitFor.response` on the action that triggers the response:

```json
{
  "action": "click",
  "selector": "#submit",
  "afterWaitFor": {
    "response": {
      "urlContains": "/api/save",
      "status": 200
    },
    "timeoutMs": 10000
  }
}
```

This arms the response listener before the click.

### evaluate or watch is rejected

Check:

```env
ALLOW_EVALUATE=true
```

Also check:

- Script length is under `MAX_EVALUATE_SCRIPT_CHARS`.
- Script returns JSON-safe values.
- Script completes before `EVALUATE_TIMEOUT_MS`.

### Missing screenshots

Check:

- `options.screenshots` is not `off`.
- A `screenshot` step has a valid `name`.
- The job reached the screenshot step.
- The artifact directory is writable.

### Missing trace

Check:

- `options.trace` is `true`.
- The job started Playwright successfully.
- The artifact directory is writable.
- The result includes `evidence.tracePath`.

### Unexpected external requests

If `unexpectedExternalRequests` contains entries:

- Confirm whether the app legitimately calls those origins.
- Add expected origins to `ALLOWED_RESOURCE_ORIGINS`.
- Investigate unexpected third-party calls in development or QA.

### DOM inspection returns sensitiveOutput true

This happens when `includeRenderedHtml` is true. Treat the response as sensitive. Prefer keeping `includeRenderedHtml` false unless you truly need the HTML.

## Operational checklist

Before connecting an AI tool:

- Set a strong `SCRAPFORAI_API_KEY`.
- Keep `ALLOWED_TARGET_ORIGINS` narrow.
- Keep `ALLOWED_RESOURCE_ORIGINS` explicit.
- Keep `ALLOW_EVALUATE=false` unless trusted local testing requires it.
- Use disposable test credentials.
- Keep artifact retention short.
- Verify auth rejection.
- Verify URL allowlist rejection.
- Verify invalid JSON rejection.
- Confirm artifacts are written only where expected.
- Avoid production data.

Before opening a tunnel:

- Confirm local health works.
- Confirm protected endpoints require the API key.
- Confirm allowlist behavior.
- Confirm no production credentials are used.
- Stop the tunnel immediately after testing.

Before sharing artifacts:

- Review screenshots.
- Review `result.json`.
- Review trace contents.
- Confirm credentials and tokens are redacted.
- Remove unnecessary artifacts.

## Glossary

| Term | Meaning |
| --- | --- |
| Artifact | File produced by a job, such as `result.json`, screenshot PNG, or trace ZIP. |
| Credential | Secret input value supplied under `credentials`; redacted from output. |
| DOM inspection | Endpoint that returns forms, controls, selectors, text, and optional diagnostics for a page. |
| Evidence | Structured diagnostic data collected during a run. |
| Exploration | A browser automation job run from a routine. |
| Origin | Scheme, host, and optional port, such as `https://dev.example.com`. |
| Routine | JSON request containing target, options, and ordered steps. |
| Step | One browser action, wait, assertion, extraction, screenshot, or collection operation. |
| Variable | Non-secret reusable input value supplied under `variables`. |

