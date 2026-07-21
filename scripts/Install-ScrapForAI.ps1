[CmdletBinding()]
param(
    [switch]$SkipPlaywrightInstall
)

$ErrorActionPreference = "Stop"

function Write-Section {
    param([string]$Text)
    Write-Host ""
    Write-Host "==== $Text ===="
}

$BundleRoot = Split-Path -Path $PSScriptRoot -Parent

Write-Section "ScrapForAI install"
Write-Host "Bundle root: $BundleRoot"

Write-Section "Checking prerequisites"

$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) {
    throw "Node.js was not found on PATH. Install Node.js LTS before continuing."
}
Write-Host "Node.js: $(node --version)"
Write-Host "npm:     $(npm --version)"

Write-Section "Installing production dependencies"
Push-Location $BundleRoot
try {
    npm ci --omit=dev
}
finally {
    Pop-Location
}

if (-not $SkipPlaywrightInstall) {
    Write-Section "Installing Playwright browser binaries"
    Push-Location $BundleRoot
    try {
        npx playwright install chromium
    }
    finally {
        Pop-Location
    }
}

Write-Section "Configuring environment"

$EnvPath = Join-Path $BundleRoot ".env"
$EnvExamplePath = Join-Path $BundleRoot ".env.example"

if (Test-Path -LiteralPath $EnvPath) {
    Write-Host ".env already exists, leaving it unchanged."
}
else {
    Copy-Item -LiteralPath $EnvExamplePath -Destination $EnvPath
    Write-Host "Created .env from .env.example. Edit it before starting the server."
}

Write-Section "Validating required variables"

$EnvContent = Get-Content -LiteralPath $EnvPath -Raw
$RequiredVars = @("SCRAPFORAI_API_KEY", "ALLOWED_TARGET_ORIGINS")
$Placeholders = @("replace-with-strong-random-value", "https://dev.example.com,https://qa.example.com")

for ($i = 0; $i -lt $RequiredVars.Count; $i++) {
    $VarName = $RequiredVars[$i]
    $Placeholder = $Placeholders[$i]
    $Pattern = "(?m)^$VarName=(.*)$"
    $Match = [regex]::Match($EnvContent, $Pattern)

    if (-not $Match.Success -or [string]::IsNullOrWhiteSpace($Match.Groups[1].Value)) {
        Write-Host "WARNING: $VarName is not set in .env" -ForegroundColor Yellow
    }
    elseif ($Match.Groups[1].Value -eq $Placeholder) {
        Write-Host "WARNING: $VarName still has its placeholder value in .env" -ForegroundColor Yellow
    }
    else {
        Write-Host "OK: $VarName is set."
    }
}

Write-Section "Done"
Write-Host "Next steps:"
Write-Host "  1. Edit .env (especially SCRAPFORAI_API_KEY and ALLOWED_TARGET_ORIGINS)."
Write-Host "  2. Start the server:  npm start"
Write-Host "  3. Verify health:     Invoke-RestMethod -Method Get -Uri http://localhost:3000/health"
