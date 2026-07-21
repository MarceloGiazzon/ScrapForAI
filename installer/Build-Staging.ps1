<#
.SYNOPSIS
  Assembles a self-contained ScrapForAI payload under installer/staging.

.DESCRIPTION
  Output layout:
    staging/
      node/                 portable Node runtime
      app/dist/             compiled server
      app/public/           UI assets
      app/node_modules/     production dependencies only
      app/package.json
      browsers/             pre-downloaded Playwright Chromium
      docs/                 user manual
      .env.example
#>
[CmdletBinding()]
param(
    [string]$NodeVersion = "22.17.0",
    [switch]$SkipNodeDownload
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Path $PSScriptRoot -Parent
$Staging = Join-Path $PSScriptRoot "staging"

function Write-Section { param([string]$Text) Write-Host "`n==== $Text ====" }

Write-Section "Cleaning staging"
if (Test-Path $Staging) { Remove-Item $Staging -Recurse -Force }
New-Item -ItemType Directory -Path $Staging -Force | Out-Null

Write-Section "Building application"
Push-Location $Root
try {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
}
finally { Pop-Location }

Write-Section "Copying application files"
$AppDir = Join-Path $Staging "app"
New-Item -ItemType Directory -Path $AppDir -Force | Out-Null

Copy-Item (Join-Path $Root "dist")            (Join-Path $AppDir "dist")   -Recurse
Copy-Item (Join-Path $Root "public")          (Join-Path $AppDir "public") -Recurse
Copy-Item (Join-Path $Root "package.json")    $AppDir
Copy-Item (Join-Path $Root "package-lock.json") $AppDir
Copy-Item (Join-Path $Root ".env.example")    $Staging

$DocsDir = Join-Path $Staging "docs"
New-Item -ItemType Directory -Path $DocsDir -Force | Out-Null
Copy-Item (Join-Path $Root "_userManual") (Join-Path $DocsDir "_userManual") -Recurse

Write-Section "Installing production dependencies"
Push-Location $AppDir
try {
    npm ci --omit=dev
    if ($LASTEXITCODE -ne 0) { throw "npm ci --omit=dev failed" }
}
finally { Pop-Location }

if (-not $SkipNodeDownload) {
    Write-Section "Downloading portable Node $NodeVersion"
    $NodeZip = Join-Path $env:TEMP "node-v$NodeVersion-win-x64.zip"
    $NodeUrl = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"

    if (-not (Test-Path $NodeZip)) {
        Invoke-WebRequest -Uri $NodeUrl -OutFile $NodeZip
    }

    $NodeExtract = Join-Path $env:TEMP "scrapforai-node-extract"
    if (Test-Path $NodeExtract) { Remove-Item $NodeExtract -Recurse -Force }
    Expand-Archive -Path $NodeZip -DestinationPath $NodeExtract -Force

    Copy-Item (Join-Path $NodeExtract "node-v$NodeVersion-win-x64") (Join-Path $Staging "node") -Recurse
    Remove-Item $NodeExtract -Recurse -Force
}

Write-Section "Pre-downloading Playwright Chromium"
# Shipping the browser is what makes offline and corporate installs work: no install-time
# network fetch, no npx, no registry access.
$BrowsersDir = Join-Path $Staging "browsers"
New-Item -ItemType Directory -Path $BrowsersDir -Force | Out-Null

$env:PLAYWRIGHT_BROWSERS_PATH = $BrowsersDir
Push-Location $AppDir
try {
    npx playwright install chromium
    if ($LASTEXITCODE -ne 0) { throw "playwright install chromium failed" }
}
finally {
    Pop-Location
    Remove-Item Env:\PLAYWRIGHT_BROWSERS_PATH -ErrorAction SilentlyContinue
}

Write-Section "Verifying staging"
$Required = @(
    "app\dist\server.js",
    "app\public\index.html",
    "app\node_modules\express",
    "node\node.exe",
    ".env.example"
)
foreach ($Item in $Required) {
    if (-not (Test-Path (Join-Path $Staging $Item))) { throw "Missing from staging: $Item" }
}

$Forbidden = @("app\src", "app\test", "app\.env")
foreach ($Item in $Forbidden) {
    if (Test-Path (Join-Path $Staging $Item)) { throw "Staging must not contain: $Item" }
}

$SizeMb = [math]::Round((Get-ChildItem $Staging -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB, 1)
Write-Host "OK. Staging size: $SizeMb MB"
