<#
.SYNOPSIS
  Produce integrity + authenticity artifacts for a packaged VSIX so it can be sideloaded safely
  in an air-gapped / CMMC environment.

.DESCRIPTION
  Always writes a SHA-256 manifest (<vsix>.sha256). When a code-signing certificate is supplied
  (PFX or a thumbprint in the local store), also writes a detached PKCS#7/CMS signature
  (<vsix>.p7s) over the VSIX bytes. Operators verify with verify-vsix.ps1 before installing.

  This is independent of the VS Code Marketplace / Open VSX (which sign on publish); it exists for
  organizations that sideload the VSIX inside the boundary.

.EXAMPLE
  ./sign-vsix.ps1 -Vsix ../packages/extension/azgov-ide.vsix
  ./sign-vsix.ps1 -Vsix x.vsix -PfxPath codesign.pfx -PfxPassword (Read-Host -AsSecureString)
  ./sign-vsix.ps1 -Vsix x.vsix -CertThumbprint A1B2C3...
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Vsix,
  [string]$PfxPath,
  [System.Security.SecureString]$PfxPassword,
  [string]$CertThumbprint
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $Vsix)) { throw "VSIX not found: $Vsix" }
$bytes = [IO.File]::ReadAllBytes((Resolve-Path $Vsix))

# 1) SHA-256 manifest.
$sha = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes)).Replace('-', '').ToLower()
$name = Split-Path $Vsix -Leaf
"$sha  $name" | Set-Content -Path "$Vsix.sha256" -Encoding ascii -NoNewline
Write-Output "SHA256  $sha"
Write-Output "wrote   $Vsix.sha256"

# 2) Optional detached PKCS#7 signature.
$cert = $null
if ($PfxPath) {
  $cert = [Security.Cryptography.X509Certificates.X509Certificate2]::new((Resolve-Path $PfxPath), $PfxPassword)
} elseif ($CertThumbprint) {
  $cert = Get-Item "Cert:\CurrentUser\My\$CertThumbprint" -ErrorAction SilentlyContinue
  if (-not $cert) { $cert = Get-Item "Cert:\LocalMachine\My\$CertThumbprint" -ErrorAction SilentlyContinue }
  if (-not $cert) { throw "Certificate thumbprint not found: $CertThumbprint" }
}
if ($cert) {
  $ci = [Security.Cryptography.Pkcs.ContentInfo]::new($bytes)
  $cms = [Security.Cryptography.Pkcs.SignedCms]::new($ci, $true) # detached
  $signer = [Security.Cryptography.Pkcs.CmsSigner]::new($cert)
  $signer.IncludeOption = [Security.Cryptography.X509Certificates.X509IncludeOption]::WholeChain
  $cms.ComputeSignature($signer)
  [IO.File]::WriteAllBytes("$Vsix.p7s", $cms.Encode())
  Write-Output "signer  $($cert.Subject)"
  Write-Output "wrote   $Vsix.p7s"
} else {
  Write-Output "note    no certificate supplied; wrote checksum only (add -PfxPath or -CertThumbprint to sign)"
}
