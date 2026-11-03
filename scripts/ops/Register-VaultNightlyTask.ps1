<#
.SYNOPSIS
  Registers a Windows scheduled task that runs Invoke-VaultNightly.ps1 every day.

.DESCRIPTION
  Runs as the current user, only while that user is logged on (no password is stored). If the machine is off
  or asleep at the time, the task runs when it is next available (-StartWhenAvailable). Use -WhatIf to see
  what would be created without creating it. Remove with:  Unregister-ScheduledTask -TaskName ScrapForAI-VaultNightly

  Note: the server must be running when the task fires; the task does not start it.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [string]$At = '02:00',
  [string]$TaskName = 'ScrapForAI-VaultNightly'
)

$ErrorActionPreference = 'Stop'
$script = Resolve-Path (Join-Path $PSScriptRoot 'Invoke-VaultNightly.ps1')
$pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue)?.Source
if (-not $pwsh) { $pwsh = (Get-Command powershell).Source }

$action = New-ScheduledTaskAction -Execute $pwsh -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive

if ($PSCmdlet.ShouldProcess($TaskName, "Register daily task at $At running $script")) {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
  Write-Host "Registered '$TaskName' (daily at $At). Run it now to test: Start-ScheduledTask -TaskName $TaskName"
}
