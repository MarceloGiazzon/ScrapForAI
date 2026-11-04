<#
.SYNOPSIS
  Prime a ScrapForAI working session: print one screen of orientation.

.DESCRIPTION
  A cold session spends its first dozen tool calls rediscovering the branch, what is
  dirty, whether the server is up and where the previous session stopped. This script
  answers all of it in ONE call. Read-only: it derives everything live and writes nothing.

  The handoff is written by Close-Session.ps1 to .claude/session-state/current.json
  (gitignored: it is working state). Without one, the newest docs/HANDOFF-*.md is only
  pointed at, never parsed.

.PARAMETER Check
  Also run `npm run typecheck` (about 10-30 s). Unit tests and smokes are never run here.

.EXAMPLE
  pwsh -NoProfile -File scripts/ai/Prepare-Session.ps1
#>
[CmdletBinding()]
param(
    [switch] $Check
)

$ErrorActionPreference = 'Stop'

# Identify the repo by its CONTENTS, never by its folder name.
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path (Join-Path $repo 'src\mcp\server.ts')) -or -not (Test-Path (Join-Path $repo 'AGENTS.md'))) {
    throw "not the ScrapForAI repo root: $repo"
}

Push-Location $repo
try {
    Write-Host ''
    Write-Host '=== ScrapForAI session prep ===' -ForegroundColor Cyan

    # --- handoff from the last session -----------------------------------
    $statePath = Join-Path $repo '.claude\session-state\current.json'
    if (Test-Path $statePath) {
        try {
            $s = Get-Content $statePath -Raw | ConvertFrom-Json
            # ConvertFrom-Json may hand back a DateTime already (culture-dependent): accept both.
            $closed = if ($s.closedAt -is [datetime]) {
                $s.closedAt
            } else {
                [datetime]::Parse([string]$s.closedAt, [cultureinfo]::InvariantCulture,
                                  [System.Globalization.DateTimeStyles]::RoundtripKind)
            }
            $age = [math]::Round(((Get-Date).ToUniversalTime() - $closed.ToUniversalTime()).TotalHours, 1)
            Write-Host ''
            Write-Host ("--- last session closed {0}h ago, at {1} ---" -f $age, $s.head) -ForegroundColor Green
            Write-Host ("did       {0}" -f $s.summary)
            Write-Host ("NEXT      {0}" -f $s.nextStep) -ForegroundColor Green
            if ($s.plan)     { Write-Host ("plan      {0}" -f $s.plan) }
            if ($s.blocked)  { Write-Host ("BLOCKED   {0}" -f $s.blocked) -ForegroundColor Yellow }
            if ($s.verified) { Write-Host ("verified  {0}" -f $s.verified) }
            if ($s.head) {
                $near = (git rev-list --count "$($s.head)..HEAD" 2>$null)
                if ($LASTEXITCODE -ne 0) {
                    Write-Host ("WARNING   handoff commit {0} is not in this history" -f $s.head) -ForegroundColor Yellow
                } elseif ($near -and [int]$near -gt 0) {
                    Write-Host ("since     {0} commit(s) landed after the handoff (the NEXT may already be done)" -f $near) -ForegroundColor Yellow
                }
            }
            Write-Host ''
        } catch {
            Write-Host 'handoff  (unreadable, ignoring)' -ForegroundColor DarkGray
        }
    } else {
        Write-Host ''
        Write-Host 'handoff  none recorded (no NEXT line)' -ForegroundColor Yellow
        $doc = Get-ChildItem -Path (Join-Path $repo 'docs') -Filter 'HANDOFF-*.md' -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending | Select-Object -First 1
        if ($doc) { Write-Host ("older    docs/{0} (prose, not a resume point; read only if asked)" -f $doc.Name) }
        Write-Host ''
    }

    # --- git -------------------------------------------------------------
    $branch = (git rev-parse --abbrev-ref HEAD 2>$null)
    $head = (git log -1 --format='%h %s' 2>$null)
    $dirty = @(git status --porcelain 2>$null)
    $ahead = (git rev-list --count '@{u}..HEAD' 2>$null)

    Write-Host ("branch   {0}" -f $branch)
    Write-Host ("head     {0}" -f $head)
    if ($dirty.Count -gt 0) {
        Write-Host ("dirty    {0} file(s)" -f $dirty.Count) -ForegroundColor Yellow
        $dirty | Select-Object -First 8 | ForEach-Object { Write-Host "           $_" }
        if ($dirty.Count -gt 8) { Write-Host ("           ... {0} more" -f ($dirty.Count - 8)) }
    } else {
        Write-Host 'dirty    clean'
    }
    if ($ahead -and $ahead -ne '0') {
        Write-Host ("unpushed {0} commit(s)" -f $ahead) -ForegroundColor Yellow
    }
    $recent = @(git log -5 --format='%h %s' 2>$null)
    if ($recent.Count -gt 0) {
        Write-Host 'recent'
        $recent | ForEach-Object { Write-Host "           $_" }
    }

    # --- environment (names only: never print a value) ---------------------
    $envPath = Join-Path $repo '.env'
    $port = '3000'
    if (Test-Path $envPath) {
        $envText = Get-Content $envPath -Raw
        $hasKey = $envText -match '(?m)^\s*SCRAPFORAI_API_KEY\s*=\s*\S{16,}'
        $hasOrigins = $envText -match '(?m)^\s*ALLOWED_TARGET_ORIGINS\s*=\s*\S+'
        if ($envText -match '(?m)^\s*PORT\s*=\s*(\d+)') { $port = $Matches[1] }
        Write-Host ("env      .env present, API key {0}, allowlist {1}" -f
            $(if ($hasKey) { 'set' } else { 'MISSING (server will not start)' }),
            $(if ($hasOrigins) { 'set' } else { 'MISSING (server will not start)' })) `
            -ForegroundColor $(if ($hasKey -and $hasOrigins) { 'Gray' } else { 'Red' })
    } else {
        Write-Host 'env      .env MISSING (cp .env.example .env, then set the key and the allowlist)' -ForegroundColor Red
    }

    # --- server ----------------------------------------------------------
    try {
        $code = (Invoke-WebRequest -Uri "http://localhost:$port/v1/schema/" -UseBasicParsing -TimeoutSec 3).StatusCode
        Write-Host ("server   up on :{0} (schema index {1})" -f $port, $code)
    } catch {
        Write-Host ("server   not reachable on :{0} (npm run dev)" -f $port) -ForegroundColor Yellow
    }

    # --- optional typecheck ----------------------------------------------
    if ($Check) {
        $out = @(npm run typecheck 2>&1)
        if ($LASTEXITCODE -eq 0) { Write-Host 'typecheck ok' -ForegroundColor Green }
        else {
            Write-Host 'typecheck FAILED' -ForegroundColor Red
            $out | Select-Object -Last 12 | ForEach-Object { Write-Host "           $_" }
        }
    }

    Write-Host ''
    Write-Host 'verify:  npm run typecheck | npm test (unit) | npm run test:smoke (Chromium, serial, ~6 min)' -ForegroundColor DarkGray
    Write-Host 'details: AGENTS.md (security model, every feature), .claude/skills/scrapforai/SKILL.md (MCP flow)' -ForegroundColor DarkGray
    Write-Host 'record the resume point before /clear: scripts/ai/Close-Session.ps1 -Summary ... -NextStep ...' -ForegroundColor DarkGray
    Write-Host ''
}
finally {
    Pop-Location
}
