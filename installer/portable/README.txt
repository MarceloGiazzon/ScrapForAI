ScrapForAI — Portable edition
=============================

No installation. No administrator rights. Nothing is written outside this folder.

HOW TO RUN
  1. Extract this ZIP anywhere (a normal folder, a USB drive, wherever).
  2. Double-click  ScrapForAI.cmd
  3. On first run it prints your API key and opens the console at
     http://127.0.0.1:3000/ui/  — sign in with that key.

WHERE THINGS LIVE
  .\app        the server and web console
  .\node       the bundled Node runtime (no system Node needed)
  .\browsers   the bundled Chromium (no separate download needed)
  .\data       your run history, artifacts, and .env  (created on first run)

DATA & REMOVAL
  Everything stays in this folder. To remove ScrapForAI completely, just delete the folder.
  Your API key is in  .\app\.env  — keep it secret; do not share this folder with it inside.

AUTOSTART (optional)
  To start ScrapForAI automatically at logon, run in PowerShell:
    powershell -ExecutionPolicy Bypass -File .\assets\Register-ScrapForAITask.ps1
  Remove it later with the same command plus  -Unregister

SECURITY
  The service listens on 127.0.0.1 only (not reachable from other machines) and requires
  your API key. See .\docs for the full manual.
