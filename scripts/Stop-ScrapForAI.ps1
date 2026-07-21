param(
    [string]$ProjectRoot,

    [int]$Port = 0,

    [switch]$SkipDocker,

    [switch]$SkipNode,

    [switch]$WhatIf
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-DefaultProjectRoot {
    return (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}

function Get-ScrapForAIPort {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root,

        [int]$RequestedPort
    )

    if ($RequestedPort -gt 0) {
        return $RequestedPort
    }

    $envFile = Join-Path $Root ".env"
    if (-not (Test-Path -LiteralPath $envFile)) {
        return 3000
    }

    foreach ($line in Get-Content -LiteralPath $envFile) {
        if ($line -match '^\s*PORT\s*=\s*(\d+)\s*(?:#.*)?$') {
            return [int]$Matches[1]
        }
    }

    return 3000
}

function Test-ScrapForAICommandLine {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CommandLine
    )

    if ([string]::IsNullOrWhiteSpace($CommandLine)) {
        return $false
    }

    return $CommandLine -match '(?i)(ScrapForAILegacy|ScrapForAI|\\scrapforai\\|/scrapforai/|src[\\/]server\.ts|dist[\\/]server\.js|tsx\s+watch\s+src[\\/]server\.ts|npm\s+run\s+(dev|start))'
}

function Get-ProcessCommandLine {
    param(
        [Parameter(Mandatory = $true)]
        [int]$ProcessId
    )

    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        return $null
    }

    return [string]$process.CommandLine
}

function Get-ListenerProcessIds {
    param(
        [Parameter(Mandatory = $true)]
        [int]$ListenPort
    )

    $connections = Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction SilentlyContinue
    if ($null -eq $connections) {
        return @()
    }

    return @(
        $connections |
            Select-Object -ExpandProperty OwningProcess -Unique |
            Where-Object { $_ -gt 0 -and $_ -ne $PID }
    )
}

function Test-StopScriptProcess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CommandLine
    )

    return $CommandLine -match '(?i)Stop-ScrapForAI\.ps1'
}

function Get-ScrapForAINodeProcessIds {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root
    )

    $projectToken = (Split-Path -Leaf $Root) -replace "'", "''"
    $filter = "(Name = 'node.exe' OR Name = 'tsx.exe') AND CommandLine LIKE '%$projectToken%'"
    $processes = Get-CimInstance Win32_Process -Filter $filter -ErrorAction SilentlyContinue
    if ($null -eq $processes) {
        return @()
    }

    $found = @()
    foreach ($process in @($processes)) {
        $processId = [int]$process.ProcessId
        if ($processId -eq $PID) {
            continue
        }

        $commandLine = [string]$process.CommandLine
        if (Test-StopScriptProcess -CommandLine $commandLine) {
            continue
        }

        if (Test-ScrapForAICommandLine -CommandLine $commandLine) {
            $found += $processId
        }
    }

    return @($found | Sort-Object -Unique)
}

function Stop-ProcessTree {
    param(
        [Parameter(Mandatory = $true)]
        [int]$ProcessId,

        [switch]$WhatIf
    )

    if ($ProcessId -le 0) {
        return $false
    }

    $existing = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $existing) {
        return $false
    }

    if ($WhatIf) {
        Write-Host "WhatIf: stop process tree PID $ProcessId ($($existing.ProcessName))"
        return $true
    }

    & taskkill.exe /PID $ProcessId /T /F 1>$null 2>$null
    Start-Sleep -Milliseconds 300

    return $null -eq (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Stop-ScrapForAIDocker {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root,

        [switch]$WhatIf
    )

    $composeFile = Join-Path $Root "docker-compose.yml"
    if (-not (Test-Path -LiteralPath $composeFile)) {
        Write-Host "Docker: skipped (docker-compose.yml not found)"
        return @()
    }

    if ($null -eq (Get-Command docker -ErrorAction SilentlyContinue)) {
        Write-Host "Docker: skipped (docker command not found)"
        return @()
    }

    $containerNames = @(
        "scrapforai-api",
        "scrapforai-cloudflared-quick-tunnel"
    )

    $runningContainers = @()
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"

    try {
        foreach ($containerName in $containerNames) {
            $containerId = & docker ps -q -f "name=^/${containerName}$" 2>$null | Select-Object -First 1
            if ($containerId) {
                $runningContainers += $containerName
            }
        }
    }
    catch {
        Write-Host "Docker: skipped (docker daemon is not running)"
        return @()
    }
    finally {
        $ErrorActionPreference = $previousErrorAction
    }

    if (@($runningContainers).Count -eq 0) {
        Write-Host "Docker: no ScrapForAI containers running"
        return @()
    }

    if ($WhatIf) {
        Write-Host ("WhatIf: docker compose down in $Root ({0})" -f ($runningContainers -join ", "))
        return $runningContainers
    }

    Push-Location -LiteralPath $Root
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = "Continue"

    try {
        Write-Host ("Docker: stopping {0}" -f ($runningContainers -join ", "))
        $dockerOutput = & docker compose down --remove-orphans 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Docker: compose down failed (exit code $LASTEXITCODE)"
            foreach ($line in @($dockerOutput)) {
                Write-Host $line
            }
            return $runningContainers
        }

        foreach ($line in @($dockerOutput)) {
            if ($line) {
                Write-Host $line
            }
        }
    }
    finally {
        $ErrorActionPreference = $previousErrorAction
        Pop-Location
    }

    return $runningContainers
}

function Write-ProcessSummary {
    param(
        [Parameter(Mandatory = $true)]
        [int[]]$ProcessIds
    )

    foreach ($processId in $ProcessIds) {
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if ($null -eq $process) {
            Write-Host "  - PID $processId (already stopped)"
            continue
        }

        $commandLine = Get-ProcessCommandLine -ProcessId $processId
        if ([string]::IsNullOrWhiteSpace($commandLine)) {
            $commandLine = "<no command line>"
        }

        if ($commandLine.Length -gt 140) {
            $commandLine = "$($commandLine.Substring(0, 137))..."
        }

        Write-Host "  - PID $processId ($($process.ProcessName)): $commandLine"
    }
}

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = Get-DefaultProjectRoot
}
else {
    $ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
}

$listenPort = Get-ScrapForAIPort -Root $ProjectRoot -RequestedPort $Port
Write-Host "ScrapForAI stop"
Write-Host "Project: $ProjectRoot"
Write-Host "Port: $listenPort"

$stoppedDocker = @()
$stoppedProcessIds = @()

if (-not $SkipDocker) {
    $stoppedDocker = @(Stop-ScrapForAIDocker -Root $ProjectRoot -WhatIf:$WhatIf)
}

if (-not $SkipNode) {
    $targetProcessIds = @(
        @(Get-ListenerProcessIds -ListenPort $listenPort) +
        @(Get-ScrapForAINodeProcessIds -Root $ProjectRoot)
    ) | Sort-Object -Unique

    if (@($targetProcessIds).Count -eq 0) {
        Write-Host "Node: no local ScrapForAI processes found"
    }
    else {
        Write-Host "Node: stopping $($targetProcessIds.Count) process tree(s)"
        Write-ProcessSummary -ProcessIds $targetProcessIds

        foreach ($processId in $targetProcessIds) {
            if (Stop-ProcessTree -ProcessId $processId -WhatIf:$WhatIf) {
                $stoppedProcessIds += $processId
            }
        }
    }
}

$stillListening = @(Get-ListenerProcessIds -ListenPort $listenPort)
if (@($stillListening).Count -gt 0 -and -not $WhatIf) {
    Write-Host "Warning: port $listenPort is still in use by PID(s): $($stillListening -join ', ')"
    exit 1
}

Write-Host "Done."
if (@($stoppedDocker).Count -gt 0) {
    Write-Host "Stopped Docker service(s): $($stoppedDocker -join ', ')"
}

if (@($stoppedProcessIds).Count -gt 0) {
    Write-Host "Stopped local process tree root PID(s): $($stoppedProcessIds -join ', ')"
}

if (@($stoppedDocker).Count -eq 0 -and @($stoppedProcessIds).Count -eq 0) {
    Write-Host "Nothing was running."
}
