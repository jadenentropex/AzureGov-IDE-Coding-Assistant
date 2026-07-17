<#
.SYNOPSIS
  Verify a VSIX against its SHA-256 manifest and (if present) its detached PKCS#7 signature,
  before sideloading in an air-gapped / CMMC environment.

.EXAMPLE
  ./verify-vsix.ps1 -Vsix ../packages/extension/azgov-ide.vsix
  ./verify-vsix.ps1 -Vsix x.vsix -RequireSignature
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Vsix,
  [switch]$RequireSignature,
  # For self-signed / internal PKI roots not chained to a trusted CA on this box.
  [switch]$AllowUntrustedChain
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $Vsix)) { throw "VSIX not found: $Vsix" }
$bytes = [IO.File]::ReadAllBytes((Resolve-Path $Vsix))
$ok = $true

# 1) Checksum.
$shaFile = "$Vsix.sha256"
if (Test-Path $shaFile) {
  $expected = ((Get-Content $shaFile -Raw).Trim() -split '\s+')[0].ToLower()
  $actual = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes)).Replace('-', '').ToLower()
  if ($expected -eq $actual) { Write-Output "checksum  OK  ($actual)" }
  else { Write-Output "checksum  FAIL  expected $expected got $actual"; $ok = $false }
} else {
  Write-Output "checksum  MISSING  ($shaFile)"; $ok = $false
}

# 2) Signature (optional unless -RequireSignature).
$sigFile = "$Vsix.p7s"
if (Test-Path $sigFile) {
  try {
    $ci = [Security.Cryptography.Pkcs.ContentInfo]::new($bytes)
    $cms = [Security.Cryptography.Pkcs.SignedCms]::new($ci, $true)
    $cms.Decode([IO.File]::ReadAllBytes($sigFile))
    $cms.CheckSignature([bool]$AllowUntrustedChain)
    $subj = $cms.SignerInfos[0].Certificate.Subject
    Write-Output "signature OK  ($subj)"
  } catch {
    Write-Output "signature FAIL  $($_.Exception.Message)"; $ok = $false
  }
} elseif ($RequireSignature) {
  Write-Output "signature MISSING  ($sigFile) and -RequireSignature was set"; $ok = $false
} else {
  Write-Output "signature none  (checksum-only)"
}

if ($ok) { Write-Output "RESULT    VERIFIED"; exit 0 } else { Write-Output "RESULT    FAILED"; exit 1 }
