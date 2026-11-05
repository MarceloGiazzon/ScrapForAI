# Target profile templates (T10.2)

A target profile says "which application, in which environment, under which rules" (`PUT /v1/targets/<id>`, needs the API key). These two are the
starting point for a **GeneXus** application. The file has no `id`: the id is the one in the URL you PUT it to (`app-dev`, `app-staging`), and it is the
value routines write in `targetProfile`.

| File | For |
|---|---|
| `genexus-dev.target.json` | The development environment. `platform: "genexus"` turns on the platform rules (see below). |
| `genexus-staging.target.json` | A shared staging environment. Same shape; `staging` **refuses** fault injection (`injectFault`) unless a person sets `flags.allowFaults: true`. |

What `platform: "genexus"` does for you, because the profile says so: a run with a `credentialSet` **logs in by itself** (it includes the routine named in
`loginRoutine`, then waits for `loginGate.urlContains`, so a login that did not complete fails there and not as a confusing timeout later); `net::ERR_ABORTED`
network failures (GeneXus' own client-side redirects) are counted as noise instead of failures; one session per credential set; and the convention lint
(GX001/GX002) is applied when you save a routine.

| Placeholder | What to put |
|---|---|
| `REPLACE_APP_NAME` | The name people know the application by. Appears in reports ("application"). |
| `REPLACE_BASE_URL` | The URL of the application's entry page, e.g. `https://dev.example.com/MyApp/`. Its origin must be in `ALLOWED_TARGET_ORIGINS` (a profile never widens the allowlist). |
| `REPLACE_CREDENTIAL_SET` | The id of a vault credential set (`POST /v1/credentials/<id>`) of a **test user** of this environment. Never a real person's. |
| `REPLACE_POST_LOGIN_URL_TOKEN` | A token that appears only in the URL after a successful login (GeneXus: the page name, e.g. `hwbwkw01`). |
| `REPLACE_BUILD_PAGE_URL` | A page whose text shows the application's version/build (a footer, an About page). Reports and evidence say which build they prove. |
| `REPLACE_BUILD_SELECTOR` | The element on that page that holds the build (e.g. `#span_vVERSION`). If the application shows no build, replace `buildInfo` with `{ "kind": "provided" }` and pass `buildId` yourself. |
| `REPLACE_HOME_URL` | The page the application opens after login. It is the first entry of the screen catalogue (used by system-evolution snapshots, direct-URL permission probes and accessibility baselines); add the others with the same shape. |

Order matters: save the **profile first** (a routine cannot be saved while its `targetProfile` does not exist: 400 `TargetProfileNotFound`), then the login routine it names
(`templates/routines/gx-login.routine.json`, saved as the routine `login`), then the rest.
`scrapforai pack apply answers.json` (the GeneXus pack) does both in the right order and refuses to send anything while a placeholder is left.
