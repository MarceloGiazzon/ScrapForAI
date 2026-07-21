# Using ScrapForAI to test NPDev apps

How to use this local ScrapForAI service for real-browser (Playwright) verification of NPDev
FinalApps, since an AI coding assistant typically has no browser/computer-use tool of its own.
Worked example and a real bug it caught: see the `panel_nested_masterdetail_primitive` and
`scrapforai_browser_testing` entries in the NPDev project's Claude memory
(`project_wmsoffice` / Tier 2 Panel primitive work, 2026-07-03/04).

## Starting it

```powershell
cd D:\WorkSpace\ScrapForAILegacy
npm run dev
```

This runs `tsx watch src/server.ts` on port 3000 by default (`PORT` in `.env`). Check it's up:

```powershell
Invoke-RestMethod -Method Get -Uri "http://localhost:3000/health"
```

It may already be running from a previous session. Before starting a duplicate, check for an
existing process:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*ScrapForAILegacy*server.ts*" } |
  Select-Object ProcessId, CommandLine
```

## Auth

Every endpoint except `GET /health` and `GET /v1/schema*` requires:

```
Authorization: Bearer <SCRAPFORAI_API_KEY>
```

The key lives in `.env` (`SCRAPFORAI_API_KEY=...`) in this directory.

## Target allowlisting — the gotcha

`.env`'s `ALLOWED_TARGET_ORIGINS` and `ALLOWED_RESOURCE_ORIGINS` gate which URLs `targetUrl` (and
`goto` steps) may point at. `src/security/validateTargetUrl.ts` explicitly **blocks bare
`localhost` hostnames** unless the exact origin is present in `ALLOWED_TARGET_ORIGINS` — this is
a deliberate SSRF guard, not a bug.

To test a local NPDev app (e.g. a FinalApp running on `http://localhost:8100`):

1. Edit `.env` and **append** (don't replace) the origin to both variables:
   ```env
   ALLOWED_TARGET_ORIGINS=https://dev.example.com,http://localhost:8100
   ALLOWED_RESOURCE_ORIGINS=https://dev.example.com,http://localhost:8100
   ```
2. **Restart the dev server.** `dotenv` loads `.env` once at process startup; `tsx watch` reloads
   on *source file* changes, not `.env` changes. Kill the running `npm run dev` process tree and
   relaunch it.

Without both steps, every scenario against `localhost` fails immediately with:

```json
{"error":{"type":"TargetUrlNotAllowed","message":"Localhost target URLs are not allowed"}}
```

## Running a scenario

`POST /v1/explorations/run` with a JSON body:

```json
{
  "scenarioName": "example",
  "targetUrl": "http://localhost:8100/some/page.html",
  "options": { "trace": false, "screenshots": "always", "collectDomOnFailure": true },
  "steps": [
    { "label": "open app", "action": "goto", "url": "$targetUrl" },
    { "label": "settle", "action": "waitForLoadState", "state": "networkidle", "timeoutMs": 15000 },
    { "label": "click something", "action": "click", "selector": "a[href=\"#some-id\"]" },
    { "label": "screenshot", "action": "screenshot", "name": "after-click" },
    { "label": "collect", "action": "collect", "what": ["console", "domText", "url", "pageErrors"] }
  ]
}
```

Useful step actions: `goto`, `click`, `fill`, `press`, `waitForSelector`, `waitForLoadState`,
`waitForTimeout`, `waitForResponse`, `extractText`, `screenshot`, `collect`, `evaluate`.

### `evaluate` — for anything a stable CSS selector can't reach

Requires `ALLOW_EVALUATE=true` in `.env` (check it's on before relying on this). Runs arbitrary
page-context JS and stores its JSON-safe return value under `extracted[<name>]`. The script body
is wrapped as `(() => { <script> })()`, so write a normal function body with `return`; you can
`return (async () => { ... })();` if you need to `await` inside (e.g. a `setTimeout` to let an
async click-handler finish before re-reading the DOM).

This is the only practical way to drive multi-row UI interactions when there's no unique
per-row selector — e.g. "find the Nth input matching a class, set its value, dispatch an `input`
event, click its row's button, wait, re-query the DOM to confirm the change stuck":

```js
return (async () => {
  const input = document.querySelectorAll('.some-editable-input')[0];
  const row = input.closest('tr');
  input.value = '777';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  row.querySelector('button')?.click();
  await new Promise(r => setTimeout(r, 2000));
  return { stuck: Array.from(document.querySelectorAll('.some-editable-input')).some(el => el.value === '777') };
})();
```

### DOM inspection before writing selectors

`POST /v1/explorations/inspect-dom` (same auth) lists every visible control with its computed
selector candidates — run this first against an unfamiliar page instead of guessing selectors:

```json
{
  "targetUrl": "http://localhost:8100/some/page.html",
  "waitUntil": "networkidle",
  "includeRenderedHtml": false,
  "includeHiddenControls": true,
  "includeConsole": true,
  "includeNetwork": false,
  "redactSensitiveValues": true
}
```

## Playwright strict-mode note

`waitForSelector` (and any locator-based step) throws if the selector resolves to more than one
element — don't combine a container id with a generic tag like `table` if multiple grids/panels
on the page could match. Prefer a `waitForLoadState: networkidle` + a short `waitForTimeout` to
let an async fetch-and-render cycle settle, then use `evaluate`'s plain `querySelectorAll` (no
strict-mode restriction) for anything ambiguous.

## NPDev-specific navigation notes

- A generated FinalApp's root `/` serves the **older** "npdev-ui" operator console
  (flows/traces/events/executions) — not the generic business-data frontend. To reach the actual
  Panel/concept-grid UI, target `http://localhost:<port>/npdev-business-ui/index.html` directly.
- Declared Panels appear in the left nav under a "PANELS" heading. Each panel's root section
  element has a real DOM id of the form `#concept-__panel-<PanelName>__` — use that as a stable
  anchor.
- The panel's data loads asynchronously after the nav click; wait for network idle (plus a short
  buffer) before asserting on rendered content, not just for the container element to exist.

## Artifacts

Screenshots and traces land under `artifacts/job_<id>/...` in this directory. Read them directly
(an image-capable tool, or just open them) for genuine visual confirmation — don't rely solely on
DOM-text assertions, since some rendering (e.g. an `<input>`'s current value) doesn't show up in
plain text-content extraction.
