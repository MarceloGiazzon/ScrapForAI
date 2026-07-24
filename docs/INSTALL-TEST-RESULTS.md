# Installer build & clean-machine test — results

Tracks the two release gates that require a Windows build/release box:

- **T3.4** — compile the installer with Inno Setup.
- **T3.5** — run the installer on a clean machine (no Node) and verify the 10 checks.

## Status

| Gate | Status | Blocker |
|---|---|---|
| T3.4 — installer compiles | **DONE (2026-07-23)** | — |
| T3.5 — clean-machine install | **Not run** | Requires a Windows VM/host without Node.js installed. |

## T3.4 result

`installer\Build-Release.ps1 -Version 1.0.0` completed successfully on the development
machine after installing Inno Setup 6.

| Field | Value |
|---|---|
| Installer | `installer\output\ScrapForAI-Setup-1.0.0.exe` |
| Size | 237.9 MB (249,420,696 bytes) |
| SHA256 | `56b689ec65968c8f20be2634672579e010d7512b1c05d3a7108d475a427f26a4` |
| Staging | 827 MB (Chromium dominates) |

Verified: the file is a valid Windows PE (`MZ`) executable, and the staging bundle contains
`node\node.exe`, `app\dist\server.js`, `app\public\index.html` (the web console), the
production `node_modules`, the pre-downloaded Chromium, and `.env.example`. The `.exe` and
`installer\staging\` are git-ignored, so they are not committed.

## Related: Docker clean-run validated (2026-07-23)

Separately from the Windows installer, the **Docker** deployment was rebuilt and run on Linux
to validate a no-Node-on-host execution path (the cross-platform equivalent of what T3.5
proves for the native installer):

- Node runs only inside the container (v24.15.0); the host does not need it.
- `/health` ok, `/` -> 302 `/ui/`, `/ui/` and assets 200, `/v1/runs` 401 unauth / 200 with
  key, login issues an `HttpOnly; SameSite=Strict` cookie.
- Required fixing the Dockerfile, which did not copy `public/` (committed).

These are the only two plan tasks that cannot be completed on the development
workstation. Everything they depend on has been prepared and verified as far as this
machine allows:

- All four installer scripts parse as valid PowerShell.
- `publicDir()` resolves to `<root>/public` from the **compiled** `dist/` layout, which is
  the assumption the staging layout relies on (verified 2026-07-23).
- The `.iss` `AppVersion` is guarded with `#ifndef`, so `Build-Release.ps1 -Version x.y.z`
  overrides it.
- The launcher writes `.env` to `{app}\app\.env`, matching where the server resolves it
  (`dist/config/env.js -> ../../.env`), and `[UninstallDelete]` targets the same path.

## Runbook — run these on a Windows build box

### T3.4 — compile

```powershell
# One-time: install Inno Setup 6 from https://jrsoftware.org/isdl.php
.\installer\Build-Release.ps1 -Version 1.0.0
```

Expect a staging payload of ~250–350 MB (Chromium dominates) and an installer at
`installer\output\ScrapForAI-Setup-1.0.0.exe`. The script prints the size and SHA256.

First run needs network access to fetch the portable Node runtime and Chromium; behind a
proxy, set `HTTPS_PROXY` first (see PRODUCTIZATION-PLAN.md, Appendix D).

### T3.5 — clean-machine test

Run on a machine or VM **without** Node installed. Record the outcome of each in the table
below.

| # | Check | Result |
|---|---|---|
| 1 | Installer runs with no administrator prompt | ☐ |
| 2 | Node is not required as a prerequisite | ☐ |
| 3 | First launch prints a generated API key and creates `.env` | ☐ |
| 4 | Browser opens `http://127.0.0.1:3000/ui/` | ☐ |
| 5 | Login with the printed key succeeds | ☐ |
| 6 | A routine runs end-to-end against an allowlisted origin (bundled Chromium found) | ☐ |
| 7 | The run appears in History with screenshots | ☐ |
| 8 | After reboot, the service is running (if "start at logon" was selected) | ☐ |
| 9 | Uninstall removes the program but leaves `%LOCALAPPDATA%\ScrapForAI\history\runs.jsonl` | ☐ |
| 10 | From another machine, `curl http://<ip>:3000/health` **fails** (loopback default) | ☐ |

## History

- 2026-07-23 — Gates recorded as blocked on this workstation (no Inno Setup, no Node-free
  VM). Installer scripts, staging assumptions and path handling verified as far as possible
  here.
- 2026-07-23 — Installed Inno Setup 6 and ran the release build: **T3.4 done**,
  `ScrapForAI-Setup-1.0.0.exe` produced and verified (see above). Docker clean-run validated
  as the no-Node execution path. **T3.5** (native Windows clean-machine test) still requires
  a Node-free Windows VM/host; the `.exe` now exists to run it against.
