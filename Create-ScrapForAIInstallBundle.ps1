[CmdletBinding()]
param(
    [string]$Root = "D:\WorkSpace\ScrapForAI",
    [string]$OutDir = "D:\WorkSpace\ScrapForAI_release",
    [switch]$SkipBuild,
    [switch]$KeepStaging
)

$ErrorActionPreference = "Stop"

function Write-Section {
    param([string]$Text)
    Write-Host ""
    Write-Host "==== $Text ===="
}

Write-Section "ScrapForAI install bundle builder"

$RootItem = Get-Item -LiteralPath $Root -ErrorAction Stop
$RootFullPath = $RootItem.FullName.TrimEnd("\", "/")

if (-not $SkipBuild) {
    Write-Section "Building project"
    Push-Location $RootFullPath
    try {
        npm run build
    }
    finally {
        Pop-Location
    }
}

$DistPath = Join-Path $RootFullPath "dist"
if (-not (Test-Path -LiteralPath (Join-Path $DistPath "server.js"))) {
    throw "dist\server.js not found. Run 'npm run build' first, or omit -SkipBuild."
}

New-Item -Path $OutDir -ItemType Directory -Force | Out-Null

$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$Staging = Join-Path $OutDir "install-staging-$Timestamp"
$ZipPath = Join-Path $OutDir "ScrapForAI-install-$Timestamp.zip"

Write-Host "Project root: $RootFullPath"
Write-Host "Staging dir:  $Staging"
Write-Host "ZIP path:     $ZipPath"

if (Test-Path -LiteralPath $Staging) {
    Remove-Item -LiteralPath $Staging -Recurse -Force
}
New-Item -Path $Staging -ItemType Directory -Force | Out-Null

Write-Section "Copying runtime files"

# Only what is needed to run the compiled server: no source, tests, node_modules,
# or dev tooling. node_modules is installed fresh on the target machine by
# scripts/Install-ScrapForAI.ps1 against the production dependency set.
$FilesToCopy = @(
    "package.json",
    "package-lock.json",
    ".env.example",
    "docker-compose.yml"
)

foreach ($RelativeFile in $FilesToCopy) {
    $SourcePath = Join-Path $RootFullPath $RelativeFile
    if (-not (Test-Path -LiteralPath $SourcePath)) {
        throw "Required file missing from project root: $RelativeFile"
    }
    Copy-Item -LiteralPath $SourcePath -Destination (Join-Path $Staging $RelativeFile)
}

Copy-Item -LiteralPath $DistPath -Destination (Join-Path $Staging "dist") -Recurse

# The repo's Dockerfile builds from source (COPY src + npm run build), which the
# install bundle does not contain. Use a runtime Dockerfile that ships the
# already-compiled dist instead.
$RuntimeDockerfile = @"
FROM mcr.microsoft.com/playwright:v1.60.0-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY dist ./dist

ENV NODE_ENV=production

EXPOSE 3000

CMD ["npm", "start"]
"@
Set-Content -LiteralPath (Join-Path $Staging "Dockerfile") -Value $RuntimeDockerfile -NoNewline

$ScriptsStaging = Join-Path $Staging "scripts"
New-Item -Path $ScriptsStaging -ItemType Directory -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $RootFullPath "scripts\Install-ScrapForAI.ps1") -Destination $ScriptsStaging
Copy-Item -LiteralPath (Join-Path $RootFullPath "scripts\Invoke-ScrapForAIRoutine.ps1") -Destination $ScriptsStaging
Copy-Item -LiteralPath (Join-Path $RootFullPath "scripts\Stop-ScrapForAI.ps1") -Destination $ScriptsStaging

Write-Section "Verifying bundle"

$RequiredInBundle = @(
    "package.json",
    "package-lock.json",
    ".env.example",
    "dist\server.js",
    "scripts\Install-ScrapForAI.ps1"
)

$Missing = @()
foreach ($RelativeFile in $RequiredInBundle) {
    if (-not (Test-Path -LiteralPath (Join-Path $Staging $RelativeFile))) {
        $Missing += $RelativeFile
    }
}
if ($Missing.Count -gt 0) {
    Write-Host "Missing from bundle:"
    $Missing | ForEach-Object { Write-Host " - $_" }
    throw "Install bundle verification failed."
}

$ForbiddenPaths = @("src", "test", "node_modules", ".git", "scripts\generate-schema.ts")
foreach ($Forbidden in $ForbiddenPaths) {
    if (Test-Path -LiteralPath (Join-Path $Staging $Forbidden)) {
        throw "Bundle unexpectedly contains '$Forbidden'."
    }
}
Write-Host "OK: bundle contains only runtime files."

Write-Section "Creating ZIP"
if (Test-Path -LiteralPath $ZipPath) {
    Remove-Item -LiteralPath $ZipPath -Force
}
Compress-Archive -Path (Join-Path $Staging "*") -DestinationPath $ZipPath -Force
Write-Host "Created: $ZipPath"

if (-not $KeepStaging) {
    Remove-Item -LiteralPath $Staging -Recurse -Force
    Write-Host "Removed staging folder."
}
else {
    Write-Host "Kept staging folder: $Staging"
}

Write-Section "Done"
Write-Host "Install bundle: $ZipPath"
Write-Host ""
Write-Host "On the target machine:"
Write-Host "  1. Expand-Archive '$ZipPath' -DestinationPath <install path>"
Write-Host "  2. cd <install path>"
Write-Host "  3. .\scripts\Install-ScrapForAI.ps1"
Write-Host "  4. Edit .env, then: npm start"
