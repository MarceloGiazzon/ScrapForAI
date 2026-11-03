# Feedback to NPDev: standing up a generated FinalApp (WmsOffice) for automated testing

**From:** ScrapForAI, while turning ledger bugs REG-216 / REG-218 into regression-vault items (2026-11-03).
**App:** `NPDev\Build\generated-finalapps\wmsoffice\App` (model `wmsoffice.core` 0.2.0, built 2026-09-29, jar sha256 `ab56a129…`).
**Goal of the consumer:** an AI agent, with no human in the loop, must start the app, create a user with a password it
chooses, log in through the real UI, and run browser tests against it every night for weeks.

That should take one command. It took two sessions, an RSA key pair, four environment variables, an undocumented endpoint
and one database wipe. The parts that cost the most come first in the list below. Each item has what happened, why it hurt an agent and a
concrete fix. Nothing in this document was changed in the NPDev repository.

---

## 1. The documented path cannot produce a user who can log in through the UI

**What happened.** `App/README.md` and `_ops/README_RUNBOOK.md` describe one auth story: the launcher provisions an
`X-Api-Key` (`secrets/api-key.env`). Following it, `login.html` is served but every login answers `missing_api_key`. Nothing
in the page, the response or the console output says "this page needs `NPDEV_AUTH_MODE=jwt`".

**Why it hurts.** The UI login is the only thing a browser test can drive, and an agent cannot set a header in a login form.
The agent concluded "wrong password" and then "broken build" before it found JWT mode in a comment in `.env.example`.

**Fix.**
- Make `missing_api_key` on `/api/auth/login` say what the login page needs, for example
  `{"error":"login_disabled_in_apikey_mode","hint":"set NPDEV_AUTH_MODE=jwt (see _ops/README_RUNBOOK.md#ui-login)"}`.
- Add a "UI login / test user" section to the runbook (see item 3).

## 2. JWT mode is four environment variables, and the launcher ignores the keys it ships

**What happened.** JWT mode needs `NPDEV_AUTH_MODE`, `NPDEV_AUTH_JWT_ISSUER`, `NPDEV_AUTH_JWT_AUDIENCE`,
`NPDEV_AUTH_JWT_PUBLICKEYPATH` and `NPDEV_AUTH_JWT_PRIVATEKEYPATH`. A key pair already sits in `App\wmsoffice-keys\`, but no
launcher looks at it. `.env.example` itself warns that `..._PRIVATE_KEY_PATH` (the spelling anyone would guess) **silently
does nothing**.

**Why it hurts.** A silent no-op on a misspelled security setting is the worst kind of failure for an agent: the app boots
"fine", in the wrong mode.

**Fix.**
- `Run-FinalApp.ps1 / Start-App.ps1 -Auth jwt`: use `wmsoffice-keys\` when present, generate a throwaway pair when not, and
  default issuer and audience for local use.
- Refuse to start when an unknown `NPDEV_AUTH_JWT_*` variable is set. Don't ignore it.
- Print the effective auth mode at boot and expose it in `/actuator/info` (today it shows `authEnabled` only).

## 3. Creating the first user is undocumented, and you get one try

**What happened.** The only way to get a UI user on a fresh database is `POST /api/auth/bootstrap-admin`. It appears in no
README. It was found by reading `JwtBearerAuthFilter.java`. It needs `displayName` as well as `username`/`password`
(this too was learned by trial). It works **once per tenant**, with no idempotent "ensure this user" and no reset short of
deleting `data\`. Here, the vault write that was meant to store the password failed after the bootstrap succeeded. The password was
gone, and the only way back was to stop the app and wipe the database.

**Why it hurts.** Anything that runs once and can't be undone forces an agent to be perfect on the first attempt. Test setup
should be repeatable.

**Fix.**
- Document `bootstrap-admin` (body, once-only rule, the tenant it lands in: `dev`) in the runbook.
- Add a local-only, repeatable seed. Either `_ops\Ensure-TestUser.ps1 -User x -PasswordFromStdin`, or an idempotent
  `POST /api/auth/bootstrap-admin` that sets the password of an existing admin when the app runs with the `dev` profile.
- Or a start flag: `Start-App.ps1 -Auth jwt -AdminUser admin -AdminPasswordFromStdin`.

## 4. Running the app writes into the generated output

**What happened.** `Start-App.ps1` opens the H2 database in `App\data\`. It writes `logs\`, `runtime-data\`, `app.pid`,
`npdev-run-app-progress.json`, `secrets\api-key.env` and `SUPER_USER_KEY.txt` inside the generated app folder. To keep the
NPDev build untouched (and get an empty database), the agent had to copy the whole 150 MB folder first.

**Why it hurts.** A test environment and the build artifact share one folder. A test run can change what the next generator
run sees, and an agent can't tell which files are output and which are state.

**Fix.** Add `-DataDir <path>` (or `NPDEV_DATA_DIR`) to the launchers so state can live outside the app. A
`-FreshDb` switch would make the copy unnecessary.

## 5. Where the Super User key goes depends on which launcher you used

Three answers in one app. `.env.example` says `./secrets/SUPER_USER_KEY.txt`. `Start-App.ps1` moves it to
`_ops\SUPER_USER_KEY.txt`. With `Run-FinalApp.ps1` it stays in the app root. `App\README.md` just says "`SUPER_USER_KEY.txt`".
**Fix:** pick one place, write it in every document, and print it at boot (the path, never the key).

## 6. `Start-App.ps1` never returns to a caller that captures its output

**What happened.** Called from a tool that captures stdout (the normal way an agent runs a command), `Start-App.ps1`
did not return for four minutes, although the app reported UP after a few seconds. The call ended the moment the JVM was
stopped, so the child JVM keeps the parent's output handle open.

**Why it hurts.** The script promises "background, waits for health, returns". For an agent it blocks until a timeout, which
looks like a hung start.

**Fix.** Start the JVM fully detached, without inherited handles (for example `Start-Process` from a
`cmd /c start /b` wrapper, or `ProcessStartInfo` with `UseShellExecute=true`), and add a regression test that runs the
script under a captured pipe.

## 7. Small inaccuracies that cost time

- `App\README.md` says "Open http://localhost:8080". This app is on **8100**. The generator knows the port, so it should write it.
- `/actuator/info` reports `npdev.commit: "UNKNOWN"` and `npdev.generator.tag: "UNKNOWN"`. A test result needs a build
  id, so the agent hashed the jar (`wmsoffice-20260929.ab56a129`). Fill in commit and tag, and add a digest of the model
  (`model.json` sha256). That one value ties a test result to exactly what was generated.
- A private key (`wmsoffice-keys\jwt-private-pkcs8.pem`) ships inside the generated output. Fine for a local throwaway, but say so
  in a README next to it, and keep it out of anything that gets copied or packaged.

## 8. Things that make the generated UI hard to test

- **The login URL contains the destination.** `login.html?next=%2Fnpdev-business-ui%2F...` includes `npdev-business-ui`, so a
  "URL contains" check passed while the login had **failed**. Every generated shell should expose a stable "signed in and
  ready" marker, for example `<body data-npdev-ready="true">` or `#npdev-shell-ready`, and the testing guide should tell tests to wait for it.
- **Grid state is only in `<input>` values.** The REG-218 grid holds each row's `divergente` flag in an editable input, so
  reading it needs in-page JavaScript. Mirror the row state into attributes, for example `<tr data-row-state="divergent">`.
- **No seed data.** WMS-12 ("login lands on seeded panels") cannot become a test, because the ledger does not describe the
  seed and the app ships none. A `_ops\Seed-Demo.ps1` (or seed files per model) would make it testable.

---

## What one command should look like

Everything above collapses into one launcher contract. An agent could follow it with no human:

```powershell
'<password>' | pwsh _ops\Start-App.ps1 -Auth jwt -DataDir D:\tmp\wms-state -FreshDb `
    -AdminUser admin -AdminPasswordFromStdin -Seed demo
# prints: auth=jwt, url=http://localhost:8100, build=<model digest>, ready marker=#npdev-shell-ready
# returns as soon as /actuator/health is UP, even under a captured pipe
```

For the record, the setup that works today is in
[../examples/wmsoffice/README.md](../examples/wmsoffice/README.md#running-wmsoffice-for-this).
