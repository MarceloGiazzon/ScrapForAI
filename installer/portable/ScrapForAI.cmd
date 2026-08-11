@echo off
REM ScrapForAI portable launcher — no installation required.
REM Double-click this file. It starts the bundled server and opens the console in your browser.
REM -ExecutionPolicy Bypass lets the script run straight from an extracted ZIP.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0assets\Start-ScrapForAI.ps1" %*
