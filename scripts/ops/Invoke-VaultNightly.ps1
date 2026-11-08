<#
.SYNOPSIS
  Nightly run of the whole regression vault, with a dated JSON log.

.DESCRIPTION
  Calls `scrapforai vault run --impact --json` and writes the single JSON object the CLI prints to
  <root>\logs\nightly\vault-<yyyyMMdd>.json (the folder is gitignored).

  Build id: by default NONE is sent, so every run reads the real build of its own target profile (its `buildInfo`
  probe, e.g. WmsOffice /actuator/info) and the history, "since when" and the Executive panel know which build was
  verified. A build id given in the request always wins over that probe, so a made-up label such as "nightly-<date>"
  would hide the real one. Pass -BuildId only when the target has no probe or you want to force a label.

  It does NOT start the server: starting a service from a scheduled task is intrusive and hides failures.
  If the server is down it exits 2 and logs why. That is "could not verify", not a regression.

  Exit codes: 0 green, 1 a test failed, 2 could not run (server down, bad usage, infrastructure).
#>
[CmdletBinding()]
param(
  [string]$BuildId,
  [string]$LogDir,
  [string]$BaseUrl,
  [switch]$FailFast
)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
if (-not $LogDir) { $LogDir = Join-Path $root 'logs\nightly' }
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd'
$logFile = Join-Path $LogDir "vault-$stamp.json"

function Write-InfraLog([string]$message) {
  $payload = [ordered]@{ cliSchema = 1; command = 'vault run'; exitCode = 2; infra = $true; buildId = $(if ($BuildId) { $BuildId } else { $null }); at = (Get-Date).ToString('o'); error = $message }
  $payload | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $logFile -Encoding utf8
  # Not Write-Error: with ErrorActionPreference=Stop it would end the script before `exit 2`.
  [Console]::Error.WriteLine($message)
}

if (-not $BaseUrl) {
  $port = '3000'
  $envFile = Join-Path $root '.env'
  if (Test-Path -LiteralPath $envFile) {
    $line = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
    if ($line) { $port = $line.Matches[0].Groups[1].Value }
  }
  $BaseUrl = "http://127.0.0.1:$port"
}

try {
  Invoke-RestMethod -Uri "$BaseUrl/health" -TimeoutSec 5 | Out-Null
} catch {
  Write-InfraLog "ScrapForAI server is not answering at $BaseUrl/health. Start it (npm run dev or npm start) and run again."
  exit 2
}

# The command comes first; the CLI rejects global options (--json, --url) placed before it.
$cliArgs = @('run', '--silent', 'cli', '--', 'vault', 'run', '--impact', '--json', '--url', $BaseUrl)
if ($BuildId) { $cliArgs += @('--build-id', $BuildId) }
if ($FailFast) { $cliArgs += '--fail-fast' }

Push-Location $root
try {
  # stdout is the single JSON object; progress goes to stderr and stays in the console/task history.
  $json = & npm @cliArgs
  $code = $LASTEXITCODE
  ($json -join "`n") | Set-Content -LiteralPath $logFile -Encoding utf8
  Write-Host "Vault nightly finished with exit code $code. Log: $logFile"
  exit $code
} finally {
  Pop-Location
}
