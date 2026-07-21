<#
.SYNOPSIS
  Starts ScrapForAI using the bundled Node runtime and browsers.
  Generates a strong API key on first run.
#>
[CmdletBinding()]
param([switch]$NoBrowser)

$ErrorActionPreference = "Stop"

$InstallRoot = Split-Path -Path $PSScriptRoot -Parent
$AppDir      = Join-Path $InstallRoot "app"
$NodeExe     = Join-Path $InstallRoot "node\node.exe"
$ServerJs    = Join-Path $AppDir "dist\server.js"
$DataDir     = Join-Path $env:LOCALAPPDATA "ScrapForAI"

# IMPORTANT: the server resolves .env relative to its own compiled location
# (dist/config/env.js -> ../../.env), so the file MUST live in $AppDir, next to dist/.
# Writing it to $InstallRoot instead would generate a key the server never reads.
$EnvPath     = Join-Path $AppDir ".env"
$EnvTemplate = Join-Path $InstallRoot ".env.example"

New-Item -ItemType Directory -Path $DataDir -Force | Out-Null

# First run: create .env from the template with a freshly generated key. Generating it
# beats warning about a placeholder — one fewer step, and no chance of shipping a default.
if (-not (Test-Path $EnvPath)) {
    Write-Host "First run: creating configuration..."
    Copy-Item $EnvTemplate $EnvPath

    $apiKey = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 48 | ForEach-Object { [char]$_ })
    (Get-Content $EnvPath -Raw) `
        -replace '(?m)^SCRAPFORAI_API_KEY=.*$', "SCRAPFORAI_API_KEY=$apiKey" `
        -replace '(?m)^HOST=.*$', 'HOST=127.0.0.1' `
        | Set-Content $EnvPath -NoNewline

    Write-Host ""
    Write-Host "Your API key (also stored in $EnvPath):" -ForegroundColor Green
    Write-Host "  $apiKey"
    Write-Host ""
    Write-Host "Sign in to the console with this key. Keep it secret." -ForegroundColor Yellow
    Write-Host ""
}

$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $InstallRoot "browsers"
$env:SCRAPFORAI_DATA_DIR      = $DataDir
$env:NODE_ENV                 = "production"

$port = 3000
$portLine = Select-String -Path $EnvPath -Pattern '^PORT=(\d+)' | Select-Object -First 1
if ($portLine) { $port = [int]$portLine.Matches[0].Groups[1].Value }

if (-not $NoBrowser) {
    Start-Job -ScriptBlock {
        param($u)
        Start-Sleep -Seconds 3
        Start-Process $u
    } -ArgumentList "http://127.0.0.1:$port/ui/" | Out-Null
}

Write-Host "Starting ScrapForAI on http://127.0.0.1:$port ..."
& $NodeExe $ServerJs
