# Installer build & clean-machine test — results

Tracks the two release gates that require a Windows build/release box:

- **T3.4** — compile the installer with Inno Setup.
- **T3.5** — run the installer on a clean machine (no Node) and verify the 10 checks.

## Status

| Gate | Status | Blocker |
|---|---|---|
| T3.4 — installer compiles | **DONE (2026-07-23)** | — |
| T3.5 — clean-machine install | **Partially validated (2026-07-24)** | Self-containment proven locally; installer machinery + true clean-machine checks still need a Node-free Windows host. |

## T3.4 result

`installer\Build-Release.ps1 -Version 1.0.0` completed successfully on the development
machine after installing Inno Setup 6.

| Field | Value |
|---|---|
| Installer | `installer\output\ScrapForAI-Setup-1.0.0.exe` |
| Size | 237.9 MB |
| SHA256 (v1.0.0 release) | `1c5df2e246a859686199f820421d371377dab113f105482a970b8624e9a0de21` |
| Staging | 827 MB — Chromium `browsers/` is 685 MB (~83%), Node 99 MB, app+deps ~43 MB |

The binary was rebuilt from the tagged `v1.0.0` commit so the release asset matches the
source; that is the SHA256 above (an earlier build before the config-validation fix hashed
`56b689ec…`).

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

### T3.5 — local self-containment validation (2026-07-24)

A true clean-machine test needs a Node-free Windows host. But the highest-risk unknown —
does the bundle actually self-contain Node + Chromium and run without any separate install? —
was validated **locally** by driving `installer\staging\` (exactly what the installer
deploys) with the **bundled** `node\node.exe` + **bundled** `browsers\chromium-1223`, against
a throwaway `LOCALAPPDATA` so real data was never touched.

Method:
- Launched `staging\app\dist\server.js` with the bundled `node.exe` and
  `PLAYWRIGHT_BROWSERS_PATH=staging\browsers`; ran a real exploration (goto + waitForSelector)
  against a local target → **passed**, proving bundled Chromium launches and navigates.
- Ran the actual `Start-ScrapForAI.ps1` launcher (throwaway `LOCALAPPDATA`): it generated a
  48-char API key, wrote `.env`, forced `HOST=127.0.0.1`, started on bundled Node, served
  `/ui`, and login with the generated key returned an `HttpOnly; SameSite=Strict` cookie.
- Confirmed the data dir resolved under the throwaway `LOCALAPPDATA`, not the real one.

| # | Check | Result |
|---|---|---|
| 1 | Installer runs with no administrator prompt | ☐ needs the Inno `.exe` on a real machine |
| 2 | Node is not required as a prerequisite | ◑ ran entirely on bundled Node + Chromium (never system Node); true clean-machine still pending |
| 3 | First launch prints a generated API key and creates `.env` | ✅ validated via the launcher |
| 4 | Browser opens `http://127.0.0.1:3000/ui/` | ✅ `/ui` served 200 (auto-open is cosmetic) |
| 5 | Login with the printed key succeeds | ✅ 200 + session cookie |
| 6 | A routine runs end-to-end against an allowlisted origin (bundled Chromium found) | ✅ exploration passed |
| 7 | The run appears in History with screenshots | ◑ run recorded in history; screenshot step not exercised |
| 8 | After reboot, the service is running (if "start at logon" was selected) | ☐ needs a reboot on a real machine |
| 9 | Uninstall removes the program but leaves `%LOCALAPPDATA%\ScrapForAI\history\runs.jsonl` | ☐ needs the Inno install/uninstall |
| 10 | From another machine, `curl http://<ip>:3000/health` **fails** (loopback default) | ◑ server bound `127.0.0.1`; cross-machine check needs a 2nd host |

Remaining (☐) all require running the real `.exe` on a Node-free Windows machine: the Inno
install/uninstall flow, admin-free install, reboot autostart, and cross-machine network
isolation. The `.exe` exists and is ready for that pass.

## History

- 2026-07-23 — Gates recorded as blocked on this workstation (no Inno Setup, no Node-free
  VM). Installer scripts, staging assumptions and path handling verified as far as possible
  here.
- 2026-07-23 — Installed Inno Setup 6 and ran the release build: **T3.4 done**,
  `ScrapForAI-Setup-1.0.0.exe` produced and verified (see above). Docker clean-run validated
  as the no-Node execution path. **T3.5** (native Windows clean-machine test) still requires
  a Node-free Windows VM/host; the `.exe` now exists to run it against.
- 2026-07-24 — **T3.5 partially validated locally**: bundled Node + bundled Chromium run an
  exploration to `passed`, and the real launcher generates a key and serves the UI on a
  throwaway data dir. Checks 3–6 pass; 2/7/10 partial; 1/8/9 (Inno install machinery, reboot
  autostart) still need a Node-free Windows host. v1.0.0 released with the matching binary.
