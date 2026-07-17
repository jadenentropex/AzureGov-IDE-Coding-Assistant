# Signing and verifying the VSIX

For air-gapped or CMMC environments the extension is sideloaded from a `.vsix` file rather than
installed from a marketplace. To preserve integrity and authenticity across that transfer, sign the
VSIX and have operators verify it before installing.

This flow is independent of the VS Code Marketplace and Open VSX, which sign extensions on publish.
It exists for organizations that distribute the VSIX inside the boundary.

## Sign (release engineer)

```powershell
# Checksum only (no certificate):
./scripts/sign-vsix.ps1 -Vsix packages/extension/azgov-ide.vsix

# Checksum + detached PKCS#7 signature from a code-signing certificate:
./scripts/sign-vsix.ps1 -Vsix packages/extension/azgov-ide.vsix -CertThumbprint <THUMBPRINT>
# or from a PFX:
./scripts/sign-vsix.ps1 -Vsix packages/extension/azgov-ide.vsix -PfxPath codesign.pfx -PfxPassword (Read-Host -AsSecureString)
```

Outputs next to the VSIX:

- `azgov-ide.vsix.sha256` - SHA-256 manifest.
- `azgov-ide.vsix.p7s` - detached CMS/PKCS#7 signature over the VSIX bytes (only when a certificate is supplied).

Use an organization code-signing certificate issued by your internal PKI (or Azure Trusted Signing,
which is available in Azure US Government). Keep the private key in an HSM or the CI secret store.

## Verify (operator, before install)

```powershell
./scripts/verify-vsix.ps1 -Vsix azgov-ide.vsix
# In environments that mandate a signature:
./scripts/verify-vsix.ps1 -Vsix azgov-ide.vsix -RequireSignature
# If the signer chains to an internal root not trusted on this box:
./scripts/verify-vsix.ps1 -Vsix azgov-ide.vsix -RequireSignature -AllowUntrustedChain
```

`RESULT VERIFIED` (exit 0) means the checksum matched and, if a signature was present, it validated.
Only then install:

```powershell
code --install-extension azgov-ide.vsix
```

## CI

The CI workflow packages the VSIX and uploads it as a build artifact. To sign in CI, add a job that
runs `scripts/sign-vsix.ps1` with a certificate from the pipeline secret store (for example Azure
Trusted Signing) and publishes the `.vsix`, `.sha256`, and `.p7s` together as the release bundle.

## Notes

- A VSIX is an Open Packaging Convention (ZIP) archive. This flow signs the whole artifact with a
  detached signature rather than embedding one, so verification does not depend on any VS Code
  feature and works fully offline.
- The signature covers the exact bytes produced by `vsce package`. Re-packaging invalidates it;
  sign the final artifact you intend to distribute.
