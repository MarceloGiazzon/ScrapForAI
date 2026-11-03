# Routine templates

Starting points for the routines the regression vault needs. They are **templates, not routines**: every
`REPLACE_*` value must be edited first, and they are `status: "draft"` so nothing runs them by accident.
`test/routine-templates.test.ts` checks that they stay valid and carry no secret.

| File | What it is |
|---|---|
| `gx-login.routine.json` | GeneXus (GAM) login with a login gate and a logout `teardown`. Save once as the routine `login`. |
| `gx-smoke-page.routine.json` | The shape of a vault item: `include` the login (pinned version), reach a page, assert, screenshot. |

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
