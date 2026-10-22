# REQ-DISC-031 — installs a Discovery Node as a Windows service: binaries and collectors under Program Files, settings,
# PKI and evidence under %ProgramData%\OpenMap, enrolment with the one-time token, then an automatic service.
#   .\install-node.ps1 -NodeId node-ryd-02 -SiteCode RYD -SchedulerUrl https://scheduler.example:4200 -Token <enrol token> [-Ca .\ca.crt]
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$NodeId,
  [Parameter(Mandatory = $true)][string]$SiteCode,
  [Parameter(Mandatory = $true)][string]$SchedulerUrl,
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$Ca = ''
)
$ErrorActionPreference = 'Stop'
$serviceName = 'OpenMapNode'
$installDir = Join-Path $env:ProgramFiles 'OpenMap'
$collectorsDir = Join-Path $installDir 'collectors'
$dataDir = Join-Path $env:ProgramData 'OpenMap'
$pkiDir = Join-Path $dataDir 'pki'
$evidenceDir = Join-Path $dataDir 'evidence'
$binSource = Join-Path $PSScriptRoot 'openmap-node.exe'
if (-not (Test-Path $binSource)) { $binSource = Join-Path (Split-Path $PSScriptRoot -Parent) 'bin\openmap-node.exe' }
if (-not (Test-Path $binSource)) { throw 'openmap-node.exe not found next to this script' }
$collectorsSource = Join-Path $PSScriptRoot 'collectors'
if (-not (Test-Path $collectorsSource)) { $collectorsSource = Join-Path (Split-Path $PSScriptRoot -Parent) 'collectors' }

New-Item -ItemType Directory -Force -Path $installDir, $collectorsDir, $dataDir, $pkiDir, $evidenceDir | Out-Null
Copy-Item $binSource (Join-Path $installDir 'openmap-node.exe') -Force
if (Test-Path $collectorsSource) { Copy-Item (Join-Path $collectorsSource '*') $collectorsDir -Force }
$lines = @(
  "OPENMAP_NODE_ID=$NodeId",
  "OPENMAP_SITE_CODE=$SiteCode",
  "OPENMAP_SCHEDULER_URL=$SchedulerUrl",
  "OPENMAP_COLLECTORS_DIR=$collectorsDir",
  "OPENMAP_EVIDENCE_DIR=$evidenceDir",
  "NODE_MTLS_CA_PATH=$(Join-Path $pkiDir 'ca.crt')",
  "NODE_MTLS_CERT_PATH=$(Join-Path $pkiDir 'node.crt')",
  "NODE_MTLS_KEY_PATH=$(Join-Path $pkiDir 'node.key')"
)
if ($Ca -ne '') { Copy-Item $Ca (Join-Path $dataDir 'bootstrap-ca.crt') -Force; $lines += "OPENMAP_BOOTSTRAP_CA_PATH=$(Join-Path $dataDir 'bootstrap-ca.crt')" }
$envFile = Join-Path $dataDir 'node.env'
Set-Content -Path $envFile -Value $lines -Encoding ascii

$env:OPENMAP_NODE_ENV_FILE = $envFile
$env:OPENMAP_ENROL_TOKEN = $Token
& (Join-Path $installDir 'openmap-node.exe') enrol
if ($LASTEXITCODE -ne 0) { throw 'enrolment failed' }
Remove-Item Env:OPENMAP_ENROL_TOKEN

$existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($existing) { Stop-Service $serviceName -Force -ErrorAction SilentlyContinue; sc.exe delete $serviceName | Out-Null; Start-Sleep -Seconds 2 }
# The service finds its settings through OPENMAP_NODE_ENV_FILE, stored with the service's own environment.
New-Service -Name $serviceName -DisplayName 'OpenMap Discovery Node' -Description 'Runs OpenMap discovery collectors for this site.' -BinaryPathName ('"' + (Join-Path $installDir 'openmap-node.exe') + '"') -StartupType Automatic | Out-Null
New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\$serviceName" -Name Environment -PropertyType MultiString -Value @("OPENMAP_NODE_ENV_FILE=$envFile") -Force | Out-Null
sc.exe failure $serviceName reset= 86400 actions= restart/30000/restart/60000/restart/300000 | Out-Null
Start-Service $serviceName
Get-Service $serviceName | Format-Table -AutoSize
Write-Host "OpenMap Discovery Node $NodeId installed; settings in $envFile"
