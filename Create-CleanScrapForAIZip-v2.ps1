[CmdletBinding()]
param(
    [string]$Root = "D:\WorkSpace\ScrapForAI",
    [string]$OutDir = "D:\WorkSpace\ScrapForAI_release",
    [switch]$KeepStaging,
    [switch]$RunNpmValidation
)

$ErrorActionPreference = "Stop"

function Write-Section {
    param([string]$Text)
    Write-Host ""
    Write-Host "==== $Text ===="
}

function Convert-ToRelativePath {
    param(
        [string]$BasePath,
        [string]$FullPath
    )

    return $FullPath.Substring($BasePath.Length).TrimStart("\", "/")
}

function Test-IsExcludedDirectoryPath {
    param([string]$RelativePath)

    $Normalized = $RelativePath -replace "\\", "/"
    $Parts = $Normalized -split "/"

    # Exclude these directory names anywhere in the tree.
    # Important: do NOT exclude every directory named "artifacts",
    # because ScrapForAI has valid source code at src/artifacts/artifactStore.ts.
    $ExcludedAnywhere = @(
        ".git",
        ".idea",
        ".vscode",
        "node_modules",
        "coverage",
        ".turbo",
        ".cache",
        "playwright-report",
        "test-results"
    )

    foreach ($Part in $Parts) {
        foreach ($Excluded in $ExcludedAnywhere) {
            if ($Part -ieq $Excluded) {
                return $true
            }
        }
    }

    # Exclude only root generated folders.
    if ($Parts.Length -gt 0 -and $Parts[0] -ieq "dist") {
        return $true
    }

    if ($Parts.Length -gt 0 -and $Parts[0] -ieq "artifacts") {
        return $true
    }

    return $false
}

function Test-IsExcludedFile {
    param([System.IO.FileInfo]$File)

    $ExcludedExactFileNames = @(
        ".env",
        ".env.local",
        ".env.development",
        ".env.production",
        ".DS_Store",
        "Thumbs.db"
    )

    $ExcludedFilePatterns = @(
        "*.log",
        "*.tmp",
        "*.zip",
        "*.7z",
        "*.rar"
    )

    foreach ($ExactName in $ExcludedExactFileNames) {
        if ($File.Name -ieq $ExactName) {
            return $true
        }
    }

    foreach ($Pattern in $ExcludedFilePatterns) {
        if ($File.Name -like $Pattern) {
            return $true
        }
    }

    return $false
}

function Test-RequiredReleaseFiles {
    param([string]$PackageRoot)

    $RequiredFiles = @(
        "package.json",
        "package-lock.json",
        "tsconfig.json",
        "src\server.ts",
        "src\artifacts\artifactStore.ts",
        "src\routes\domInspection.routes.ts",
        "src\runner\inspectDom.ts",
        "src\schemas\domInspectionRequest.schema.ts",
        "src\config\env.ts"
    )

    $Missing = @()

    foreach ($RelativeFile in $RequiredFiles) {
        $FullPath = Join-Path $PackageRoot $RelativeFile
        if (-not (Test-Path -LiteralPath $FullPath)) {
            $Missing += $RelativeFile
        }
    }

    if ($Missing.Count -gt 0) {
        Write-Host "Missing required files:"
        $Missing | ForEach-Object { Write-Host " - $_" }
        throw "Clean ZIP verification failed because required source files are missing."
    }

    Write-Host "OK: required source files are present."
}

function Test-ForbiddenReleaseFiles {
    param([string]$PackageRoot)

    $ForbiddenMatches = Get-ChildItem -LiteralPath $PackageRoot -Recurse -Force |
        Where-Object {
            $Relative = Convert-ToRelativePath -BasePath $PackageRoot.TrimEnd("\", "/") -FullPath $_.FullName
            $Normalized = $Relative -replace "\\", "/"

            $IsRootGeneratedFolder =
                $Normalized -eq "dist" -or
                $Normalized -like "dist/*" -or
                $Normalized -eq "artifacts" -or
                $Normalized -like "artifacts/*"

            $IsForbiddenAnywhere =
                $Normalized -match "(^|/)\.git(/|$)" -or
                $Normalized -match "(^|/)\.idea(/|$)" -or
                $Normalized -match "(^|/)\.vscode(/|$)" -or
                $Normalized -match "(^|/)node_modules(/|$)" -or
                $Normalized -match "(^|/)coverage(/|$)" -or
                $Normalized -match "(^|/)playwright-report(/|$)" -or
                $Normalized -match "(^|/)test-results(/|$)"

            $IsForbiddenFile =
                $_.Name -ieq ".env" -or
                $_.Name -ieq ".env.local" -or
                $_.Name -ieq ".env.development" -or
                $_.Name -ieq ".env.production" -or
                $_.Name -like "*.zip" -or
                $_.Name -like "*.7z" -or
                $_.Name -like "*.rar" -or
                $_.Name -like "*.log" -or
                $_.Name -like "*.tmp"

            $IsRootGeneratedFolder -or $IsForbiddenAnywhere -or $IsForbiddenFile
        }

    if ($ForbiddenMatches.Count -gt 0) {
        Write-Host "Forbidden files/folders found:"
        $ForbiddenMatches | Select-Object FullName | Format-Table -AutoSize
        throw "Clean ZIP verification failed because forbidden files were found."
    }

    Write-Host "OK: no forbidden files or folders found."
}

Write-Section "ScrapForAI clean ZIP builder v2"

$RootItem = Get-Item -LiteralPath $Root -ErrorAction Stop
$RootFullPath = $RootItem.FullName.TrimEnd("\", "/")

New-Item -Path $OutDir -ItemType Directory -Force | Out-Null

$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$ZipPath = Join-Path $OutDir "ScrapForAI-clean-$Timestamp.zip"
$Staging = Join-Path $OutDir "staging-$Timestamp"

Write-Host "Project root: $RootFullPath"
Write-Host "Output dir:   $OutDir"
Write-Host "Staging dir:  $Staging"
Write-Host "ZIP path:     $ZipPath"

if (Test-Path -LiteralPath $Staging) {
    Remove-Item -LiteralPath $Staging -Recurse -Force
}

New-Item -Path $Staging -ItemType Directory -Force | Out-Null

Write-Section "Copying clean files"

$CopiedCount = 0
$SkippedCount = 0

$AllFiles = Get-ChildItem -LiteralPath $RootFullPath -Recurse -File -Force

foreach ($File in $AllFiles) {
    $RelativePath = Convert-ToRelativePath -BasePath $RootFullPath -FullPath $File.FullName

    $Skip = $false

    if (Test-IsExcludedDirectoryPath -RelativePath $RelativePath) {
        $Skip = $true
    }

    if (Test-IsExcludedFile -File $File) {
        $Skip = $true
    }

    if (-not $Skip) {
        $Destination = Join-Path $Staging $RelativePath
        $DestinationDir = Split-Path -Path $Destination -Parent

        New-Item -Path $DestinationDir -ItemType Directory -Force | Out-Null
        Copy-Item -LiteralPath $File.FullName -Destination $Destination -Force

        $CopiedCount = $CopiedCount + 1
    }

    if ($Skip) {
        $SkippedCount = $SkippedCount + 1
    }
}

Write-Host "Copied files:  $CopiedCount"
Write-Host "Skipped files: $SkippedCount"

Write-Section "Pre-ZIP verification"
Test-RequiredReleaseFiles -PackageRoot $Staging
Test-ForbiddenReleaseFiles -PackageRoot $Staging

Write-Section "Creating ZIP"

if (Test-Path -LiteralPath $ZipPath) {
    Remove-Item -LiteralPath $ZipPath -Force
}

$StagingChildren = Get-ChildItem -LiteralPath $Staging -Force

if ($StagingChildren.Count -eq 0) {
    throw "Staging folder is empty. ZIP was not created."
}

Compress-Archive -Path (Join-Path $Staging "*") -DestinationPath $ZipPath -Force

Write-Host "Created:"
Write-Host $ZipPath

Write-Section "Post-ZIP verification"

$VerifyDir = Join-Path $OutDir "verify-$Timestamp"

if (Test-Path -LiteralPath $VerifyDir) {
    Remove-Item -LiteralPath $VerifyDir -Recurse -Force
}

New-Item -Path $VerifyDir -ItemType Directory -Force | Out-Null
Expand-Archive -Path $ZipPath -DestinationPath $VerifyDir -Force

Test-RequiredReleaseFiles -PackageRoot $VerifyDir
Test-ForbiddenReleaseFiles -PackageRoot $VerifyDir

Write-Section "Optional npm validation"

if ($RunNpmValidation) {
    Push-Location $VerifyDir
    try {
        npm ci
        npm run typecheck
        npm run build
    }
    finally {
        Pop-Location
    }

    Write-Host "OK: npm ci, typecheck, and build passed in extracted package."
}

if (-not $RunNpmValidation) {
    Write-Host "Skipped npm validation. To enable it, run this script with -RunNpmValidation."
}

Write-Section "Top-level ZIP contents"
Get-ChildItem -LiteralPath $VerifyDir -Force | Select-Object Name | Format-Table -AutoSize

Remove-Item -LiteralPath $VerifyDir -Recurse -Force

if (-not $KeepStaging) {
    Remove-Item -LiteralPath $Staging -Recurse -Force
    Write-Host ""
    Write-Host "Removed staging folder."
}

if ($KeepStaging) {
    Write-Host ""
    Write-Host "Kept staging folder:"
    Write-Host $Staging
}

Write-Section "Done"
Write-Host "Clean ZIP:"
Write-Host $ZipPath
