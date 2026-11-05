# Routine templates

Starting points for the routines the regression vault needs. They are **templates, not routines**: every
`REPLACE_*` value must be edited first, and they are `status: "draft"` so nothing runs them by accident.
`test/routine-templates.test.ts` checks that they stay valid and carry no secret.

| File | What it is |
|---|---|
| `gx-login.routine.json` | GeneXus (GAM) login with a login gate and a logout `teardown`. Save once as the routine `login`. |
| `gx-smoke-page.routine.json` | The shape of a vault item: `include` the login (pinned version), reach a page, assert, screenshot. |
| `gx-work-with-search.routine.json` | The most common GeneXus screen (T10.2): a Work With list with a filter. Searches a known value and checks the grid and that no raw error reaches the screen. Read-only. |
| `gx-transaction-insert.routine.json` | A Transaction form (T10.2): inserts a record with a generated unique code, finds it in the list (exactly one row) and deletes it in the `teardown`. Changes data. |
| `gx-prompt-select.routine.json` | A Prompt (T10.2): opens the lookup window, filters it, picks a row and checks that the form shows what was picked. Needs the prompt to open inside the page (an iframe). Read-only. |
| `chaos-save-500.routine.json` | Controlled chaos (T7.2): the save call answers HTTP 500 once; the page must say so in its own words and print no raw error. |
| `chaos-search-slow.routine.json` | The search call arrives 10 s late (the real request goes through); the page must show a loading state and recover. |
| `chaos-json-corrupt.routine.json` | The API answers 200 with a truncated JSON body (the server is not called); the page must neither crash nor print a parser error. |

| `concurrency-simultaneous-edit.routine.json` | Two users open the same record and press save together (`parallel`). Exactly ONE save must be accepted: a counter on the page goes up by one (+2 = lost update, +0 = neither saved). |
| `concurrency-double-submit.routine.json` | Two sessions submit the same new record, with the same unique value, together. Exactly ONE row must exist afterwards, and no raw error reaches the screen. |
| `concurrency-single-session.routine.json` | The same user logs in twice. The newest session wins; the first is sent back to the login page. Needs `maxSessionsPerCredential >= 2` (see below). |
| `concurrency-approval-flow.routine.json` | A requester sends a request, an approver finds it in the inbox and approves it, the requester sees the state change. Two users in order, no race. |

The three `chaos-` templates use `injectFault`, which only touches allowlisted origins and is refused on a `staging` target profile unless it sets `flags.allowFaults`.

## The `concurrency-` templates (T6.6)

They use actors (T6.4) and, for the two races, `parallel` (T6.5). Things to know before adapting one:

- **Two credential sets.** Each user is an actor with its own set (`REPLACE_CREDENTIAL_SET` and `REPLACE_CREDENTIAL_SET_B`, both in the
  profile's `credentialSets`). The routine has **no** `credentialSet` of its own on purpose: `main` is never used, and a `credentialSet` on the routine
  would still take a session lock for a user nobody logs in as (a third session, or a second one for the same user). The login is `include`d once per
  actor (`"actor": "first"`), with its pinned `version`; its logout `teardown` runs for each actor too, which is why the convention warning GX002
  ("logs in and has no teardown") is suppressed in these templates, with that reason written in `lintSuppress`.
- **Only the last action races.** There is no barrier: the branches start together when the block starts, so everything that can be done before
  (login, open the page, type) is outside the block. Reading the clock is not a synchronisation: a green run is ONE sample of a race, not proof that
  there is none. Repeat it with a suite (`retries`/`samples`) or a schedule to give a rare race a chance.
- **Who wins is not decided.** Each user's answer is kept in `extracted` (`outcome_first`, `outcome_second`) so the report shows what each was told, but
  the verdict does not depend on which one won. It rests on what the application STORED: a counter (edit) or a count of rows (double submit). If your
  application has no number that moves with an accepted save, an audit/history grid with one row per save does (the text of the element must be only
  the number, nothing else, because the formula oracle parses it).
- **They change data.** The edit leaves the record with the winner's value; the double submit and the approval create a record. Point them at a
  disposable record or data set, or add `teardown` steps that delete what was created (a teardown runs even after a failure, and its failure never
  replaces the verdict).
- **Typed data is generated** (`parameters`, no seed needed: a fresh one is recorded in `result.parameters`), so two runs never collide on a leftover.
  `includeBoundaries: false` keeps the edge values (empty string, one too long) out: this is not a validation test. Add a `fill` for every other
  required field of your form, with `valueFromParameter` or `valueFromCredential` (never a literal that looks like a secret; the save lint refuses it).
- **`single-session` needs a deliberate setting.** Both actors use the SAME credential set, which the single-session lock forbids unless the profile says
  `"flags": { "maxSessionsPerCredential": 2 }` (`PUT /v1/targets/<id>`); without it the run is refused with 400 `TooManySessionsForCredential`. The flag
  applies to every run on that profile, so use a dev profile, or a profile of its own with a dedicated test user. The routine assumes the policy of
  the GeneXus conventions (section 2): the newest login wins. If your application refuses the NEW login instead, the second login gate fails, so
  swap the halves: after `login-second` assert that the second session is at `REPLACE_LOGIN_URL_TOKEN` and that the first one is still on the page.
- **Do not name an actor like a secret.** Redaction blanks a vault value wherever it appears, so an actor called `admin` next to a user `admin` shows
  as `[REDACTED]`. The templates use `first`, `second`, `requester` and `approver`.
- **Step budget.** `MAX_STEPS_PER_JOB` (50) counts the steps AFTER the includes are expanded: each login is 8 steps plus 1 of teardown, a
  `parallel` block counts as 1 plus the steps of its branches. The templates stay at 31-43; an added step or two is fine, a long form is not
  (raise `MAX_STEPS_PER_JOB`, or put the form filling in a routine of its own and `include` it as the actor).

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
| `REPLACE_PAGE_URL`, `REPLACE_PAGE_URL_TOKEN`, `REPLACE_MAIN_SELECTOR` | The page under test, a token of its URL, a stable selector. In the `concurrency-` templates the page is the one where the users act: the record being edited, the creation form, the request form |
| `REPLACE_API_PATH` | A fragment of the URL of the call to break, e.g. `/api/orders` (find it in the run's `network` evidence). Matched as a substring of the full URL |
| `REPLACE_TRIGGER_SELECTOR` | The control that makes the page call that API (the save button, the search button); in the `concurrency-` templates, the save / submit / send button |
| `REPLACE_MESSAGE_SELECTOR` | Where the page shows its error message to the user; in the `concurrency-` templates, where it shows the answer to a save (saved, lock message, already exists) |
| `REPLACE_LOADING_SELECTOR` | The loading indicator the page shows while it waits |
| `REPLACE_CREDENTIAL_SET_B` | `concurrency-`: the credential set of the SECOND user (another user of the same profile, so two sessions never share a login). `single-session` is the exception: it logs the SAME user in twice and uses only `REPLACE_CREDENTIAL_SET` |
| `REPLACE_LOGIN_URL_TOKEN` | A token that appears only in the URL of the login page (GeneXus: `wblogin`) |
| `REPLACE_FIELD_SELECTOR` | The field the scenario types into: the field being edited, the unique code of the new record, or the subject of the request |
| `REPLACE_COUNTER_SELECTOR` | An element whose text is only a number that goes up by exactly one for every ACCEPTED save (version, revision, "times edited", rows of an audit grid) |
| `REPLACE_LIST_URL` | The list (grid) of the records the scenario creates |
| `REPLACE_SEARCH_SELECTOR` | The filter field of that grid (the scenario types the unique value and presses Enter; use your search button if Enter does not search) |
| `REPLACE_ROW_SELECTOR` | A row of that grid. After the search only the rows with the unique value remain, so their count is the number of records created |
| `REPLACE_INBOX_URL` | The approver's inbox: the page where requests waiting for approval are listed |
| `REPLACE_ITEM_SELECTOR` | The control that opens the (first) request of that list |
| `REPLACE_APPROVE_SELECTOR` | The control that approves the open request |
| `REPLACE_STATUS_URL` | The page where the requester sees the state of requests ("my requests") |
| `REPLACE_STATUS_SELECTOR` | The element that shows the state of the request after the search |
| `REPLACE_SEARCH_TEXT` | `gx-work-with-search`, `gx-prompt-select`: a value that exists in your test data (a code, a name). It is stored in the routine as a parameter, so it must not be a secret |
| `REPLACE_SEARCH_BUTTON_SELECTOR` | The button that runs the search of the Work With list |
| `REPLACE_FIRST_ROW_TEXT_SELECTOR` | An element of the first grid row that shows the searched value (GeneXus ids look like `span_vNAME_0001`: the `_0001` is the row) |
| `REPLACE_DELETE_SELECTOR` | `gx-transaction-insert` teardown: the control of the first row that starts a deletion |
| `REPLACE_CONFIRM_DELETE_SELECTOR` | `gx-transaction-insert` teardown: the control that confirms it (often the transaction's Confirm button in delete mode) |
| `REPLACE_PROMPT_BUTTON_SELECTOR` | The button or icon next to the field that opens the prompt |
| `REPLACE_PROMPT_URL_TOKEN` | A part of the prompt window's URL (GeneXus: the prompt object's name, e.g. `hprompt`). It selects the frame the `gx-prompt-select` steps run in |
| `REPLACE_PROMPT_FILTER_SELECTOR`, `REPLACE_PROMPT_SEARCH_SELECTOR` | The filter field and the search button, INSIDE the prompt |
| `REPLACE_PROMPT_ROW_SELECTOR` | A row of the prompt's grid |
| `REPLACE_PROMPT_PICK_SELECTOR` | The control of the first row that selects it (a "Select" link or the row itself) |
| `REPLACE_RESULT_SELECTOR` | The element of the form that shows the description of what was picked |
| `REPLACE_EXPECTED_TEXT` | That description, as the page writes it |
| `REPLACE_APPROVED_TEXT` | The text of the approved state, as the page writes it (e.g. `Approved`) |

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
