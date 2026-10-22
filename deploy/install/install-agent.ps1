# REQ-DISC-004 — installs the host agent as a Windows service: binary under Program Files, settings and PKI material
# under %ProgramData%\OpenMap\agent, enrolment with the one-time token, then a service that starts automatically.
# Run from an elevated PowerShell in the unpacked release directory:
#   .\install-agent.ps1 -NodeUrl https://node.site.example:4300 -Token <enrol token> -Ca .\ca.crt [-AgentId host.example.local] [-IntervalMs 900000]
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$NodeUrl,
  [Parameter(Mandatory = $true)][string]$Token,
  [Parameter(Mandatory = $true)][string]$Ca,
  [string]$AgentId = ([System.Net.Dns]::GetHostEntry($env:COMPUTERNAME).HostName.ToLowerInvariant()),
  [int]$IntervalMs = 0
)
$ErrorActionPreference = 'Stop'
$serviceName = 'OpenMapAgent'
$installDir = Join-Path $env:ProgramFiles 'OpenMap'
$dataDir = Join-Path $env:ProgramData 'OpenMap\agent'
$source = Join-Path $PSScriptRoot 'openmap-agent.exe'
if (-not (Test-Path $source)) { $source = Join-Path (Split-Path $PSScriptRoot -Parent) 'bin\openmap-agent.exe' }
if (-not (Test-Path $source)) { throw 'openmap-agent.exe not found next to this script' }

New-Item -ItemType Directory -Force -Path $installDir, $dataDir | Out-Null
Copy-Item $source (Join-Path $installDir 'openmap-agent.exe') -Force
Copy-Item $Ca (Join-Path $dataDir 'bootstrap-ca.crt') -Force
# Only Administrators and SYSTEM may read the agent's key material and settings.
$acl = Get-Acl $dataDir
$acl.SetAccessRuleProtection($true, $false)
foreach ($identity in @('BUILTIN\Administrators', 'NT AUTHORITY\SYSTEM')) {
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
}
Set-Acl $dataDir $acl

$lines = @(
  "OPENMAP_AGENT_NODE_URL=$NodeUrl",
  "OPENMAP_AGENT_ID=$AgentId",
  "OPENMAP_BOOTSTRAP_CA_PATH=$(Join-Path $dataDir 'bootstrap-ca.crt')"
)
if ($IntervalMs -gt 0) { $lines += "OPENMAP_AGENT_INTERVAL_MS=$IntervalMs" }
Set-Content -Path (Join-Path $dataDir 'agent.env') -Value $lines -Encoding ascii

$env:OPENMAP_ENROL_TOKEN = $Token
& (Join-Path $installDir 'openmap-agent.exe') enrol
if ($LASTEXITCODE -ne 0) { throw 'enrolment failed' }
Remove-Item Env:OPENMAP_ENROL_TOKEN

$existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($existing) { Stop-Service $serviceName -Force -ErrorAction SilentlyContinue; sc.exe delete $serviceName | Out-Null; Start-Sleep -Seconds 2 }
New-Service -Name $serviceName -DisplayName 'OpenMap host agent' -Description 'Reports this host''s inventory to the OpenMap Discovery Node.' -BinaryPathName ('"' + (Join-Path $installDir 'openmap-agent.exe') + '"') -StartupType Automatic | Out-Null
sc.exe failure $serviceName reset= 86400 actions= restart/30000/restart/60000/restart/300000 | Out-Null
Start-Service $serviceName
Get-Service $serviceName | Format-Table -AutoSize
Write-Host "OpenMap agent $AgentId installed; settings in $dataDir\agent.env"
