[CmdletBinding()]
param(
  [switch]$WhatIf
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$taskName = "msg-hub"
$ruleName = "msg-hub 18795"

function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if ($WhatIf) {
  Write-Host "msg-hub uninstall (dry run)"
  Write-Host "  would remove scheduled task: $taskName"
  Write-Host "  would remove firewall rule:  $ruleName"
  Write-Host "  would stop run-loop.cmd and node server.js under: $root"
  Write-Host "No changes made."
  exit 0
}

if (-not (Test-Admin)) {
  throw "Administrator rights required. Re-run from an elevated PowerShell with: powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
}

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "scheduled task removed: $taskName"
} else {
  Write-Host "scheduled task not found: $taskName"
}

if (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue) {
  Remove-NetFirewallRule -DisplayName $ruleName
  Write-Host "firewall rule removed: $ruleName"
} else {
  Write-Host "firewall rule not found: $ruleName"
}

$rootPattern = [regex]::Escape($root)
Get-CimInstance Win32_Process |
  Where-Object {
    $_.CommandLine -and
    $_.CommandLine -match $rootPattern -and
    ($_.CommandLine -match "run-loop\.cmd" -or $_.CommandLine -match "server\.js")
  } |
  ForEach-Object {
    try {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop
      Write-Host "stopped pid $($_.ProcessId): $($_.Name)"
    } catch {
      Write-Warning "could not stop pid $($_.ProcessId): $($_.Exception.Message)"
    }
  }

# Fallback: the node child may not carry the project path in its command line.
$listener = Get-NetTCPConnection -LocalPort 18795 -State Listen -ErrorAction SilentlyContinue
if ($listener) {
  foreach ($ownerPid in ($listener | Select-Object -ExpandProperty OwningProcess -Unique)) {
    try {
      Stop-Process -Id $ownerPid -Force -ErrorAction Stop
      Write-Host "stopped listener pid $ownerPid on port 18795"
    } catch {
      Write-Warning "could not stop listener pid ${ownerPid}: $($_.Exception.Message)"
    }
  }
}

Write-Host "done. data\ is kept; remove it manually after a backup if you want a clean reset."
