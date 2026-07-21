<#
.SYNOPSIS
  Registers ScrapForAI to start at logon via Scheduled Task.

.NOTES
  A Scheduled Task is used rather than a Windows Service because it needs no administrator
  rights, which keeps the whole install per-user. For a machine-wide service install, wrap
  Start-ScrapForAI.ps1 with NSSM instead.
#>
[CmdletBinding()]
param([switch]$Unregister)

$ErrorActionPreference = "Stop"
$TaskName = "ScrapForAI"

if ($Unregister) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Removed scheduled task '$TaskName'."
    return
}

$StartScript = Join-Path $PSScriptRoot "Start-ScrapForAI.ps1"

$action    = New-ScheduledTaskAction -Execute "powershell.exe" `
                -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$StartScript`" -NoBrowser"
$trigger   = New-ScheduledTaskTrigger -AtLogOn
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "Registered '$TaskName' to start at logon."
