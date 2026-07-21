[CmdletBinding()]
param([string]$Version = "1.0.0")

$ErrorActionPreference = "Stop"

Write-Host "==== ScrapForAI release build $Version ===="

# Build-Staging sets $ErrorActionPreference = "Stop" and throws on failure, so a failed
# staging aborts here without needing an exit-code check ($LASTEXITCODE only reflects
# native commands and would otherwise carry a stale value).
& (Join-Path $PSScriptRoot "Build-Staging.ps1")

$Iscc = (Get-Command iscc -ErrorAction SilentlyContinue).Source
if (-not $Iscc) {
    $Candidates = @(
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
        "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
    )
    $Iscc = $Candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $Iscc) { throw "Inno Setup (iscc) not found. Install from https://jrsoftware.org/isdl.php" }
}

$IssPath = Join-Path $PSScriptRoot "ScrapForAI.iss"
& $Iscc "/DAppVersion=$Version" $IssPath
if ($LASTEXITCODE -ne 0) { throw "Inno Setup compilation failed" }

$Output = Join-Path $PSScriptRoot "output\ScrapForAI-Setup-$Version.exe"
if (-not (Test-Path $Output)) { throw "Expected installer not found at $Output" }

$SizeMb = [math]::Round((Get-Item $Output).Length / 1MB, 1)

Write-Host ""
Write-Host "Installer: $Output ($SizeMb MB)" -ForegroundColor Green
Write-Host "SHA256:    $((Get-FileHash $Output -Algorithm SHA256).Hash)"
