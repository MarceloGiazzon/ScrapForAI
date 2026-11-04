# Routine templates

Starting points for the routines the regression vault needs. They are **templates, not routines**: every
`REPLACE_*` value must be edited first, and they are `status: "draft"` so nothing runs them by accident.
`test/routine-templates.test.ts` checks that they stay valid and carry no secret.

| File | What it is |
|---|---|
| `gx-login.routine.json` | GeneXus (GAM) login with a login gate and a logout `teardown`. Save once as the routine `login`. |
| `gx-smoke-page.routine.json` | The shape of a vault item: `include` the login (pinned version), reach a page, assert, screenshot. |
| `chaos-save-500.routine.json` | Controlled chaos (T7.2): the save call answers HTTP 500 once; the page must say so in its own words and print no raw error. |
| `chaos-search-slow.routine.json` | The search call arrives 10 s late (the real request goes through); the page must show a loading state and recover. |
| `chaos-json-corrupt.routine.json` | The API answers 200 with a truncated JSON body (the server is not called); the page must neither crash nor print a parser error. |

The three `chaos-` templates use `injectFault`, which only touches allowlisted origins and is refused on a `staging` target profile unless it sets `flags.allowFaults`.

## Using one

1. Find the real selectors with `inspect_dom` (or ask the agent with the `scrapforai` skill). The login selectors
   (`#vUSER`, `#vUSRPSWING`, `BTNENTER`) come from an existing sample and are common in GAM logins, but **confirm
   them** on your application.
2. Replace the placeholders:

| Placeholder | What to put |
|---|---|
| `REPLACE_TARGET_PROFILE` | Id of a target profile (`PUT /v1/targets/<id>`), e.g. `app-dev` |
| `REPLACE_CREDENTIAL_SET` | Id of a vault credential set allowed for that profile, e.g. `gam-admin` |
| `REPLACE_POST_LOGIN_URL_TOKEN` | A token that appears only in the URL after a successful login (GeneXus: the page name, e.g. `hwbwkw01`) |
| `REPLACE_LOGOUT_URL` | The URL that ends the session. Without it a second run bounces to `wblogin` (single session per user) |
| `REPLACE_SURFACE` | The area this proves, e.g. `checkout`. Impact ordering matches on it |
| `REPLACE_PAGE_URL`, `REPLACE_PAGE_URL_TOKEN`, `REPLACE_MAIN_SELECTOR` | The page under test, a token of its URL, a stable selector |
| `REPLACE_API_PATH` | A fragment of the URL of the call to break, e.g. `/api/orders` (find it in the run's `network` evidence). Matched as a substring of the full URL |
| `REPLACE_TRIGGER_SELECTOR` | The control that makes the page call that API (the save button, the search button) |
| `REPLACE_MESSAGE_SELECTOR` | Where the page shows its error message to the user |
| `REPLACE_LOADING_SELECTOR` | The loading indicator the page shows while it waits |

3. Save it, with the credentials only by name:
   ```powershell
   $key  = (Select-String -Path .env -Pattern '^SCRAPFORAI_API_KEY=(.+)$').Matches.Groups[1].Value
   $body = Get-Content templates\routines\gx-login.routine.json -Raw   # after editing
   Invoke-RestMethod -Method Put -Uri http://localhost:3000/v1/routines/login -Headers @{Authorization="Bearer $key"} -ContentType 'application/json' -Body $body
   ```
   Then run it once (`npm run cli -- run login`) and, when it passes, set `"status": "active"` (a new version).
4. Other routines `include` it with `"version": 1`. Pin the version: without it the current one is used and the
   proof is not reproducible.

Never write a password into a template. Use `valueFromCredential`; the server refuses literals that look like secrets.
