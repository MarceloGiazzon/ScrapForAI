<#
.SYNOPSIS
  Record where this session stopped, so /prep in the next one resumes without re-deriving it.

.DESCRIPTION
  Writes .claude/session-state/current.json (the live handoff, overwritten) and appends one
  line to .claude/session-state/history.jsonl. The folder is gitignored: a handoff is
  working state. It derives the mechanical part itself (branch, HEAD, commits since the
  previous close, dirty files, unpushed count); the narrative is the caller's.

  NEVER put a secret, password or token in these parameters: the file is plain text.

.PARAMETER Summary   What this session actually did. One or two sentences.
.PARAMETER NextStep  The exact resume point, specific enough to act on without re-reading anything.
.PARAMETER Plan      Path to the plan or roadmap being followed, if any.
.PARAMETER Blocked   Anything genuinely blocked, and on what (a gate, a person, a cross-repo task).
.PARAMETER Verified  What verification actually ran ("typecheck 0 errors, npm test 592/592"), or "none".

.EXAMPLE
  pwsh -NoProfile -File scripts/ai/Close-Session.ps1 `
      -Summary "Added the /prep command and session scripts." `
      -NextStep "Define the PREP target profile once the URL is known." `
      -Verified "typecheck ok"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $Summary,
    [Parameter(Mandatory = $true)] [string] $NextStep,
    [string] $Plan = '',
    [string] $Blocked = '',
    [string] $Verified = 'none'
)

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path (Join-Path $repo 'src\mcp\server.ts')) -or -not (Test-Path (Join-Path $repo 'AGENTS.md'))) {
    throw "not the ScrapForAI repo root: $repo"
}

$stateDir = Join-Path $repo '.claude\session-state'
if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Path $stateDir -Force | Out-Null }
$currentPath = Join-Path $stateDir 'current.json'
$historyPath = Join-Path $stateDir 'history.jsonl'

Push-Location $repo
try {
    $branch = (git rev-parse --abbrev-ref HEAD 2>$null)
    $head = (git rev-parse --short HEAD 2>$null)
    $headSubject = (git log -1 --format='%s' 2>$null)
    $dirty = @(git status --porcelain 2>$null)
    $unpushed = (git rev-list --count '@{u}..HEAD' 2>$null)

    $sinceHead = $null
    if (Test-Path $currentPath) {
        try { $sinceHead = (Get-Content $currentPath -Raw | ConvertFrom-Json).head } catch { }
    }
    $landed = @()
    if ($sinceHead) { $landed = @(git log --oneline "$sinceHead..HEAD" 2>$null) }

    $record = [ordered]@{
        closedAt      = (Get-Date).ToUniversalTime().ToString('o')
        branch        = $branch
        head          = $head
        headSubject   = $headSubject
        summary       = $Summary
        nextStep      = $NextStep
        plan          = $Plan
        blocked       = $Blocked
        verified      = $Verified
        dirtyCount    = $dirty.Count
        dirtyFiles    = @($dirty | Select-Object -First 20)
        unpushed      = if ($unpushed) { [int]$unpushed } else { 0 }
        landedCommits = $landed
    }

    $utf8 = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($currentPath, ($record | ConvertTo-Json -Depth 6), $utf8)
    [System.IO.File]::AppendAllText($historyPath, (($record | ConvertTo-Json -Depth 6 -Compress) + "`n"), $utf8)

    Write-Host ''
    Write-Host '=== session closed ===' -ForegroundColor Cyan
    Write-Host ("branch    {0} @ {1}" -f $branch, $head)
    if ($landed.Count -gt 0) {
        Write-Host ("landed    {0} commit(s) this session:" -f $landed.Count)
        $landed | ForEach-Object { Write-Host "            $_" }
    }
    if ($dirty.Count -gt 0) { Write-Host ("dirty     {0} file(s) left uncommitted" -f $dirty.Count) -ForegroundColor Yellow }
    if ($record.unpushed -gt 0) { Write-Host ("unpushed  {0} commit(s)" -f $record.unpushed) -ForegroundColor Yellow }
    Write-Host ("verified  {0}" -f $Verified)
    Write-Host ''
    Write-Host 'NEXT STEP (what /prep resumes from):' -ForegroundColor Green
    Write-Host ("  {0}" -f $NextStep)
    if ($Plan) { Write-Host ("  plan: {0}" -f $Plan) }
    if ($Blocked) { Write-Host ("  BLOCKED: {0}" -f $Blocked) -ForegroundColor Yellow }
    Write-Host ''
    Write-Host ("saved to {0}" -f $currentPath) -ForegroundColor DarkGray
    Write-Host 'safe to /clear now.' -ForegroundColor Green
    Write-Host ''
}
finally {
    Pop-Location
}
