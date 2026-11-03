<#
.SYNOPSIS
  Runs the regression vault, likeliest-to-break first, for the files changed in an application repo.

.DESCRIPTION
  Run it BEFORE merging or deploying to the shared environment. It lists the files changed between
  -Base and HEAD in -AppRepo, pipes them to `scrapforai vault run --impact`, and stops at the first red
  item (-FailFast, default on). The build id is "<branch>.<short sha>" of the app repo, so a red result
  proves WHICH unpublished build was caught.

  Exit codes are the CLI's: 0 green, 1 a test failed (a bug), 2 anything else (server down, bad usage,
  a run that could not execute). Treat 2 as "could not verify", never as "the bug is back".

.EXAMPLE
  .\scripts\ops\Invoke-VaultPreMerge.ps1 -AppRepo D:\WorkSpace\WmsOffice -Base main
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$AppRepo,
  [string]$Base = 'main',
  [string]$BuildId,
  [switch]$NoFailFast
)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')

if (-not (Test-Path -LiteralPath (Join-Path $AppRepo '.git'))) {
  # Not Write-Error: with ErrorActionPreference=Stop it would end the script before `exit 2`.
  [Console]::Error.WriteLine("AppRepo '$AppRepo' is not a git repository.")
  exit 2
}

if (-not $BuildId) {
  $branch = (git -C $AppRepo rev-parse --abbrev-ref HEAD).Trim()
  $sha = (git -C $AppRepo rev-parse --short HEAD).Trim()
  # The CLI accepts only letters, digits, _ . + - /
  $BuildId = (("$branch.$sha") -replace '[^\w.+\-/]', '-')
}

$changed = @(git -C $AppRepo diff --name-only "$Base...HEAD")
if ($LASTEXITCODE -ne 0) {
  [Console]::Error.WriteLine("git diff against '$Base' failed in '$AppRepo'. Does the base branch exist?")
  exit 2
}
Write-Host "Build: $BuildId | changed files: $($changed.Count) (base: $Base)" -ForegroundColor Cyan

$cliArgs = @('run', 'cli', '--', 'vault', 'run', '--impact', '--changed-files', '-', '--build-id', $BuildId)
if (-not $NoFailFast) { $cliArgs += '--fail-fast' }

Push-Location $root
try {
  # An empty change list still runs the vault (ordered by recent failures and severity).
  $changed | & npm @cliArgs
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
