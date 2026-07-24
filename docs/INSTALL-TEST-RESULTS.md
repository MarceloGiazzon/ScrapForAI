# Installer build & clean-machine test — results

Tracks the two release gates that require a Windows build/release box:

- **T3.4** — compile the installer with Inno Setup.
- **T3.5** — run the installer on a clean machine (no Node) and verify the 10 checks.

## Status

| Gate | Status | Blocker |
|---|---|---|
| T3.4 — installer compiles | **Not run** | Inno Setup 6 is not installed on the development machine. |
| T3.5 — clean-machine install | **Not run** | Requires a Windows VM/host without Node.js installed. |

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
  here. To be executed on a release box before the first published build.
