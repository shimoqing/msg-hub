[CmdletBinding()]
param(
  [switch]$WhatIf,
  [switch]$SkipFirewall,
  [switch]$DisableBroadNodeRules,
  # Node executable for the hub; defaults to node on PATH.
  [string]$NodePath,
  # Client CIDR allowed through the firewall rule. Loopback-only unless you
  # pass your LAN range (e.g. -RemoteCidr 192.168.0.0/24).
  [string]$RemoteCidr = "127.0.0.1/32"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $root "data"
$logDir = Join-Path $dataDir "logs"
$tokenFile = Join-Path $dataDir "token.txt"
$vbs = Join-Path $PSScriptRoot "run-hidden.vbs"
$taskName = "msg-hub"
$ruleName = "msg-hub 18795"
$port = 18795

function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

$node = $NodePath
if ($node -and -not (Test-Path $node)) { throw "NodePath not found: $node" }
if (-not $node) {
  $command = Get-Command node -ErrorAction SilentlyContinue
  if (-not $command) { throw "node.exe not found; install Node 24 or pass -NodePath <path>" }
  $node = $command.Source
}

if ($RemoteCidr -eq "127.0.0.1/32" -and -not $PSBoundParameters.ContainsKey("RemoteCidr") -and -not $SkipFirewall) {
  Write-Warning "no -RemoteCidr given: the firewall rule will only cover loopback. Pass your LAN range (e.g. -RemoteCidr 192.168.0.0/24) if other machines should reach this hub."
}

$broadRules = @(
  Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue |
    Where-Object { $_.Program -eq $node } |
    Get-NetFirewallRule -ErrorAction SilentlyContinue |
    Where-Object { $_.Direction -eq "Inbound" -and $_.Action -eq "Allow" -and $_.Enabled -eq "True" }
)

if ($WhatIf) {
  Write-Host "msg-hub install (dry run)"
  Write-Host "  project:        $root"
  Write-Host "  node:           $node"
  Write-Host "  token file:     $tokenFile (exists: $(Test-Path $tokenFile))"
  Write-Host "  scheduled task: $taskName -> wscript.exe `"$vbs`""
  if ($SkipFirewall) {
    Write-Host "  firewall rule:  SKIPPED (-SkipFirewall)"
  } else {
    Write-Host "  firewall rule:  $ruleName inbound TCP $port from $RemoteCidr"
  }
  Write-Host "  data/log dirs:  $dataDir / $logDir"
  if ($broadRules.Count -gt 0) {
    Write-Host "  broad rules:    $($broadRules.Count) existing inbound Allow rule(s) for this node.exe"
    Write-Host "                  (any port / any remote); -DisableBroadNodeRules would disable them"
  }
  Write-Host "No changes made."
  exit 0
}

if (-not $SkipFirewall -and -not (Test-Admin)) {
  throw "Administrator rights required for the firewall rule. Re-run elevated, or use -SkipFirewall to install only the scheduled task."
}
if (-not (Test-Path $vbs)) { throw "missing wrapper: $vbs" }

New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

if (-not (Test-Path $tokenFile)) {
  Push-Location $root
  try {
    & $node server.js --init-token
    if ($LASTEXITCODE -ne 0) { throw "failed to generate token (exit $LASTEXITCODE)" }
  } finally {
    Pop-Location
  }
}

& icacls $tokenFile /inheritance:r /grant:r "$($env:USERNAME):R" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls failed on $tokenFile" }
Write-Host "token ready: $tokenFile (current user read-only)"

if ($SkipFirewall) {
  Write-Warning "firewall step skipped by -SkipFirewall; the app-level ALLOWED_CIDRS check and token still apply"
} else {
  if ($broadRules.Count -gt 0) {
    Write-Warning "existing inbound Allow rule(s) for $node permit any port/remote and can override the CIDR intent of '$ruleName':"
    $broadRules | Select-Object -ExpandProperty DisplayName -Unique | ForEach-Object { Write-Warning "  $_" }
    if ($DisableBroadNodeRules) {
      $broadRules | Select-Object -ExpandProperty Name -Unique | ForEach-Object {
        Disable-NetFirewallRule -Name $_ | Out-Null
      }
      Write-Host "broad node.exe inbound Allow rules disabled; re-enable them manually if another service needs them"
    } else {
      Write-Warning "pass -DisableBroadNodeRules to disable them (may affect other Node services on this machine)"
    }
  }

  $rule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
  if ($null -eq $rule) {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
      -Protocol TCP -LocalPort $port -RemoteAddress $RemoteCidr -Profile Any | Out-Null
    Write-Host "firewall rule created: $ruleName ($RemoteCidr -> TCP $port)"
  } else {
    Write-Host "firewall rule already exists: $ruleName"
  }
}

$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbs`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -Hidden
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Description "msg-hub multi-agent chat hub" -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host "scheduled task registered and started: $taskName"

Start-Sleep -Seconds 2
try {
  $health = Invoke-RestMethod "http://127.0.0.1:$port/health" -TimeoutSec 5
  Write-Host "health: ok=$($health.ok) last_id=$($health.last_id) sse_clients=$($health.sse_clients)"
} catch {
  Write-Warning "service registered but /health did not answer yet: $($_.Exception.Message)"
  Write-Host "check data\console.log and data\logs\"
}
