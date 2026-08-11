<#
.SYNOPSIS
  Packages the staged runtime into a no-install portable ZIP.

.DESCRIPTION
  Reuses installer\staging (produced by Build-Staging.ps1 / Build-Release.ps1) and wraps it
  with the launcher, a double-click .cmd, a portable marker and a README. The result runs
  from any folder using the bundled Node + Chromium, storing all data under .\data.

  Output: installer\output\ScrapForAI-Portable-<Version>.zip

  Layout inside the ZIP (top-level folder "ScrapForAI"):
    ScrapForAI.cmd            double-click launcher
    portable.txt              marker -> data stays in .\data
    README.txt
    assets\Start-ScrapForAI.ps1
    assets\Register-ScrapForAITask.ps1
    node\  app\  browsers\  docs\  .env.example
#>
[CmdletBinding()]
param(
    [string]$Version = "1.0.0",
    # Light: only affects the output filename; run Build-Staging -Light first so staging is
    # the shell-only variant.
    [switch]$Light
)

$ErrorActionPreference = "Stop"
$VariantSuffix = if ($Light) { "-Light" } else { "" }
$Staging = Join-Path $PSScriptRoot "staging"
$Portable = Join-Path $PSScriptRoot "portable"
$AssetsSrc = Join-Path $PSScriptRoot "assets"
$OutDir = Join-Path $PSScriptRoot "output"

if (-not (Test-Path (Join-Path $Staging "node\node.exe"))) {
    throw "staging not found. Run installer\Build-Staging.ps1 (or Build-Release.ps1) first."
}

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

# Assemble the ZIP tree in a temp folder so the archive has a single clean root.
$Assembly = Join-Path $env:TEMP ("sfa-portable-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$AppRoot = Join-Path $Assembly "ScrapForAI"
New-Item -ItemType Directory -Path $AppRoot -Force | Out-Null

try {
    Write-Host "Assembling portable tree..."
    Copy-Item (Join-Path $Staging "*") $AppRoot -Recurse

    $AssetsDst = Join-Path $AppRoot "assets"
    New-Item -ItemType Directory -Path $AssetsDst -Force | Out-Null
    Copy-Item (Join-Path $AssetsSrc "Start-ScrapForAI.ps1") $AssetsDst
    Copy-Item (Join-Path $AssetsSrc "Register-ScrapForAITask.ps1") $AssetsDst

    Copy-Item (Join-Path $Portable "*") $AppRoot

    # Windows-native CRLF for the files opened directly (a LF-only .cmd can misbehave in cmd.exe).
    foreach ($name in @("ScrapForAI.cmd", "README.txt", "portable.txt")) {
        $p = Join-Path $AppRoot $name
        $t = ([System.IO.File]::ReadAllText($p) -replace "`r`n", "`n") -replace "`n", "`r`n"
        [System.IO.File]::WriteAllText($p, $t)
    }

    $Zip = Join-Path $OutDir "ScrapForAI-Portable$VariantSuffix-$Version.zip"
    if (Test-Path $Zip) { Remove-Item $Zip -Force }

    Write-Host "Compressing (this takes a minute; Chromium is large)..."
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    # includeBaseDirectory: $true -> entries are prefixed with the "ScrapForAI" folder.
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
        $AppRoot, $Zip, [System.IO.Compression.CompressionLevel]::Optimal, $true)

    $SizeMb = [math]::Round((Get-Item $Zip).Length / 1MB, 1)
    Write-Host ""
    Write-Host "Portable ZIP: $Zip ($SizeMb MB)" -ForegroundColor Green
    Write-Host "SHA256:       $((Get-FileHash $Zip -Algorithm SHA256).Hash)"
}
finally {
    if (Test-Path $Assembly) { Remove-Item $Assembly -Recurse -Force }
}
