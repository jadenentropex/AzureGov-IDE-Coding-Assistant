<#
  Dev-VM bootstrap for the AzureGov IDE Coding Assistant POC.

  Run automatically by the poc.bicep CustomScriptExtension. Installs VS Code and the developer
  toolchain, builds and installs this extension from source, and pre-seeds VS Code settings that
  point the extension at the freshly deployed Gov endpoint and audit pipeline. The VM's managed
  identity (granted the Cognitive Services OpenAI User and Monitoring Metrics Publisher roles by
  the template) is the keyless auth path - no keys are placed on the box.

  Best-effort and idempotent-ish; logs to C:\azgov\bootstrap.log. This is a POC bootstrap and may
  need per-environment tuning (proxy, restricted egress, image differences).
#>
param(
  [string]$Endpoint,
  [string]$DceIngest,
  [string]$DcrId,
  [string]$Stream = 'Custom-AzgovIdeAudit_CL',
  [string]$RepoUrl = 'https://github.com/jadenentropex/AzureGov-IDE-Coding-Assistant.git',
  [string]$AdminUser = 'azgovadmin'
)
$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force -Path 'C:\azgov' | Out-Null
Start-Transcript -Path 'C:\azgov\bootstrap.log' -Append

function Log($m) { Write-Output ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) }

# 1) Chocolatey.
try {
  Set-ExecutionPolicy Bypass -Scope Process -Force
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072
  Invoke-Expression ((New-Object Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
} catch { Log "choco install error: $($_.Exception.Message)" }
$choco = "$env:ProgramData\chocolatey\bin\choco.exe"

# 2) Developer toolchain.
Log 'installing toolchain (git, node, vscode, az, python, terraform)...'
& $choco install -y --no-progress git nodejs-lts vscode azure-cli python terraform 2>&1 | Out-Null

# Refresh PATH from the machine + user scopes so freshly installed tools resolve.
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
$npm = "C:\Program Files\nodejs\npm.cmd"
$code = "C:\Program Files\Microsoft VS Code\bin\code.cmd"

# 3) Build and package the extension from source.
try {
  Log 'cloning + building the extension...'
  Set-Location 'C:\azgov'
  if (-not (Test-Path 'C:\azgov\repo')) { & git clone --depth 1 $RepoUrl 'C:\azgov\repo' 2>&1 | Out-Null }
  Set-Location 'C:\azgov\repo'
  & $npm ci 2>&1 | Out-Null
  & $npm run build 2>&1 | Out-Null
  Set-Location 'C:\azgov\repo\packages\extension'
  & $npm exec --yes -- @vscode/vsce package --no-dependencies --out C:\azgov\azgov-ide.vsix 2>&1 | Out-Null
  Log ('vsix built: ' + (Test-Path 'C:\azgov\azgov-ide.vsix'))
} catch { Log "build error: $($_.Exception.Message)" }

# 4) Pre-seed VS Code user settings pointing at the deployed endpoint + audit pipeline.
try {
  $settingsDir = "C:\Users\$AdminUser\AppData\Roaming\Code\User"
  New-Item -ItemType Directory -Force -Path $settingsDir | Out-Null
  $settings = [ordered]@{
    'azgovIde.endpoint'               = $Endpoint.TrimEnd('/')
    'azgovIde.authMode'               = 'managed'
    'azgovIde.store'                  = $false
    'azgovIde.approveWrites'          = $true
    'azgovIde.auditEnabled'           = $true
    'azgovIde.auditIngestionEndpoint' = $DceIngest
    'azgovIde.auditDcrImmutableId'    = $DcrId
    'azgovIde.auditStreamName'        = $Stream
    'azgovIde.allowedModels'          = @('gpt-4.1', 'gpt-5.1')
  }
  ($settings | ConvertTo-Json) | Set-Content -Path "$settingsDir\settings.json" -Encoding UTF8
  Log 'seeded VS Code settings'
} catch { Log "settings error: $($_.Exception.Message)" }

# 5) Install the extension in the admin user's context at first logon (extensions are per-user).
try {
  $installer = @"
`$ErrorActionPreference = 'Continue'
& '$code' --install-extension 'C:\azgov\azgov-ide.vsix' --force
"@
  Set-Content -Path 'C:\azgov\install-ext.ps1' -Value $installer -Encoding UTF8
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-ExecutionPolicy Bypass -File C:\azgov\install-ext.ps1'
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $AdminUser
  Register-ScheduledTask -TaskName 'InstallAzgovExtension' -Action $action -Trigger $trigger -RunLevel Limited -User $AdminUser -Force | Out-Null
  Log 'registered first-logon extension install task'
} catch { Log "task error: $($_.Exception.Message)" }

Log 'bootstrap complete'
Stop-Transcript
