# AzureGov IDE Coding Assistant

An Azure-native, in-boundary AI coding assistant for CMMC Level 2 / CUI organizations. It
delivers a Claude-Code / Codex style chat, edit, and agent experience in VS Code while keeping
source code and conversation context inside the customer's authorized Azure US Government
boundary.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![CI](https://github.com/jadenentropex/AzureGov-IDE-Coding-Assistant/actions/workflows/ci.yml/badge.svg)](https://github.com/jadenentropex/AzureGov-IDE-Coding-Assistant/actions/workflows/ci.yml)
[![Platform](https://img.shields.io/badge/platform-VS%20Code-007ACC.svg)](https://code.visualstudio.com/)
[![Cloud](https://img.shields.io/badge/cloud-Azure%20US%20Government-0078D4.svg)](https://azure.microsoft.com/en-us/explore/global-infrastructure/government/)

Built and maintained by Entropex, LLC (https://entropex.io). Free and open source under the
Apache License, Version 2.0.

> Not Claude. Azure US Government does not host Anthropic Claude. The agent is GPT-powered via
> the Azure OpenAI Responses API in Azure Government (gpt-5.1 / gpt-4.1). The value here is the
> architecture: the tool is the compliance surface, not the model.

## Table of contents

- [Why this exists](#why-this-exists)
- [Highlights](#highlights)
- [Security model](#security-model)
- [Compliance mapping](#compliance-mapping)
- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Commands](#commands)
- [Repository layout](#repository-layout)
- [Development](#development)
- [Signing and verifying the VSIX](#signing-and-verifying-the-vsix)
- [Status](#status)
- [Contributing](#contributing)
- [Security policy](#security-policy)
- [License](#license)
- [About Entropex](#about-entropex)

## Why this exists

Modern AI coding assistants are enormously useful, but the mainstream ones send your source
code and prompts to commercial cloud endpoints. For organizations that handle Controlled
Unclassified Information (CUI) under CMMC / NIST SP 800-171, that data flow is a
non-starter: CUI must stay inside an authorized boundary (Azure US Government), and every
action must be attributable and auditable.

This project provides the same day-to-day developer experience while making the boundary and
the audit trail first-class. Tools execute locally in the workspace, so source code stays on
the workstation; only the model call crosses the wire, to an Azure OpenAI resource inside the
Gov boundary, with server-side state turned off so no conversation is retained in the service.

## Highlights

- Dedicated chat panel (activity-bar view) with streaming responses, a thinking view, and
  four modes: Ask, Plan (read-only), Auto (no prompts), and Review.
- Local, workspace-confined tools: list_dir, read_file, grep, create_folder, write_file, and
  run_terminal (background flag for servers/tunnels, 120s timeout, process-tree kill).
- Inline change cards with plus/minus diffs and Approve / Reject buttons - no OS popups - plus
  one-click Undo of any file the agent wrote.
- Per-message and per-chat token and cost tracking, with an enforceable cost budget.
- Keyless Azure Government authentication (managed identity or Entra device code); break-glass
  API key as a fallback.
- Azure OpenAI Responses API engine (function calling, streaming, store=false), isolated behind
  a portable agent core so a different backend can be added without touching the UI.
- A one-command, control-mapped compliance evidence bundle and a guided installer that stands
  up the whole in-boundary stack.

## Security model

Security is the point of this tool, not a feature bolted on. The controls are layered so a
single failure - including a prompt injection - does not become a CUI leak.

| Layer | What it does | Settings |
| --- | --- | --- |
| CUI boundary | Endpoint is pinned to the Gov data plane (`*.openai.azure.us`) plus an allow-list; models are checked against an allow-list. The agent refuses to send anywhere else. | `azgovIde.endpoint`, `azgovIde.allowedEndpointHosts`, `azgovIde.allowedModels` |
| No state at rest | `store=false`: Azure retains no server-side conversation state, so no CUI is written at rest in the service. | `azgovIde.store` |
| Identity | Keyless managed identity (IMDS) or Entra device code; break-glass key only in SecretStorage. Each audit event is attributed to the resolved Entra identity. | `azgovIde.authMode` |
| Human approval | File writes and shell commands require inline approval. Plan / Review modes are read-only. | `azgovIde.approveWrites` |
| Prompt-injection defense | All tool output (file contents, command output, API responses) is framed to the model as untrusted data; the system prompt forbids following instructions embedded in it. | always on |
| Terminal allow-list | If set, run_terminal only runs approved executables. Every executable in a chained or substituted command must be allow-listed, so a second command cannot ride in behind an approved one. | `azgovIde.commandAllowlist` |
| Egress guard | Blocks ad-hoc network tools (curl, wget, scp, ssh, ...) so CUI cannot be exfiltrated through the shell. Package managers and Azure CLI are unaffected. | `azgovIde.blockNetworkCommands` |
| Hard Auto-mode gate | Auto mode auto-applies file edits, but shell commands still require approval unless allow-listed - so a prompt injection cannot silently run commands. | `azgovIde.autoModeAllowTerminal` |
| Secret redaction | Keys, tokens, passwords, private keys, and connection strings are masked in the audit log, change cards, and tool output. Value-level masking keeps commands readable; disk bytes and model input are unchanged. | `azgovIde.redactSecrets` |
| Tamper-evident audit | Every action is written to an append-only, hash-chained JSONL log, anchored to a persisted tip (detects edit, insert, delete, and truncation), and forwarded off-box to Log Analytics as an independent copy. | `azgovIde.auditEnabled`, `azgovIde.auditIngestionEndpoint`, `azgovIde.auditDcrImmutableId` |
| Cost control | An enforceable per-chat USD budget stops the agent before it overruns. | `azgovIde.costBudgetUsd` |

Security-relevant settings are policy-lockable (GPO / Intune) so an org can enforce them
centrally rather than trusting a per-user settings file.

## Compliance mapping

The extension can generate a machine-derived evidence bundle mapped to NIST SP 800-171 Rev. 2 /
CMMC Level 2. Run "AzureGov IDE: Generate compliance evidence bundle" and it writes a JSON
report and a human-readable SSP excerpt into an `azgov-evidence/` folder, derived from the live,
effective configuration and audit state (including a fresh audit-chain verification) - not
hand-written claims. Representative controls:

| Control | Family | Covered by |
| --- | --- | --- |
| 3.1.1 / 3.1.2 / 3.1.5 | AC | keyless identity, human approval, command allow-list |
| 3.1.20 | AC | endpoint pin + egress guard |
| 3.3.1 / 3.3.2 / 3.3.8 | AU | hash-chained attributable audit log + off-box copy |
| 3.4.2 | CM | policy-lockable settings, model / endpoint allow-lists |
| 3.5.2 | IA | managed identity / Entra keyless auth |
| 3.13.1 / 3.13.16 | SC | Gov boundary + Private Endpoint, store=false |
| 3.14.2 | SI | prompt-injection defense, denylist, Auto-mode gate |

This repository is a strong starting point, not a certification. Standing it up for real CUI
requires the backend hardening and evidence artifacts described under Status, plus your own
System Security Plan and a C3PAO assessment. Entropex provides that support (see About Entropex).

## Architecture

```
Developer workstation / PAW (inside the boundary)        Azure US Government boundary
+---------------------------------------------+          +--------------------------------+
| VS Code extension                            |          | Azure OpenAI Responses API     |
|   chat panel (activity-bar view) + modes     | -------> |   *.openai.azure.us            |
|   agents-client (portable agent loop)        |  model   |   gpt-5.1 / gpt-4.1            |
|   local tools (read/write/grep/run_terminal) |   call   |   store=false (no CUI at rest) |
|     confined to the workspace root           |          |   Private Endpoint (PE-only)   |
|   managed-identity / Entra / key auth        |          +--------------------------------+
|   tamper-evident audit log  ----------------------------------> Log Analytics (audit copy)
+---------------------------------------------+          (Logs Ingestion API, *.ingest.monitor.azure.us)

   Source code and tools run locally. Only the model call and the audit copy cross the wire,
   and both stay inside the Azure US Government boundary.
```

The engine is the Azure OpenAI Responses API (function calling, streaming, and `store=false`,
verified live in Gov). It sits behind a portable agent core (`agents-client`) so the UI, tools,
auth, and audit do not depend on the specific backend. The classic Assistants API is
deliberately not used - it retires 2026-08-26.

## Quick start

### Option A: guided install (recommended)

Requires the Azure CLI logged in to Azure US Government and rights to create resources and role
assignments. Node.js 18+.

```bash
# 1) Sign in to Azure US Government
az cloud set --name AzureUSGovernment
az login

# 2) Stand up the in-boundary stack and write locked settings
node packages/create-azgov-ide/index.js
#   or non-interactively:
node packages/create-azgov-ide/index.js --config answers.json
```

The installer deploys `infra/main.bicep` (Azure OpenAI + optional Private Endpoint, Log
Analytics, and the audit Data Collection Endpoint / Rule), reads the outputs, and writes a
locked `.vscode/settings.json` pinning the extension to the fresh endpoint and audit pipeline.
See [packages/create-azgov-ide/README.md](packages/create-azgov-ide/README.md).

### Option B: install the extension manually

```bash
# Build a VSIX
npm install
npm run build
cd packages/extension
npx @vscode/vsce package --no-dependencies --out azgov-ide.vsix

# Verify integrity (air-gapped sideload), then install
# (see docs/SIGNING.md to sign/verify)
code --install-extension azgov-ide.vsix
```

Then set at minimum `azgovIde.endpoint` (your Gov endpoint) and `azgovIde.authMode`, open a
folder, and use the AzureGov panel in the activity bar. The identity you use needs the
"Cognitive Services OpenAI User" role on the resource.

## Configuration

Settings live under the `azgovIde.*` namespace. The security-relevant ones are policy-lockable.
The most important:

| Setting | Default | Description |
| --- | --- | --- |
| `azgovIde.endpoint` | `https://aoai-azgov-ide.openai.azure.us` | Azure OpenAI Gov endpoint. |
| `azgovIde.model` | `gpt-4.1` | Model deployment (pick by task complexity). |
| `azgovIde.authMode` | `managed` | `managed`, `entra`, or `key`. |
| `azgovIde.store` | `false` | Keep false for CMMC / CUI. |
| `azgovIde.approveWrites` | `true` | Require approval for writes and commands. |
| `azgovIde.allowedModels` | list | Org-approved model deployment names. |
| `azgovIde.commandAllowlist` | `[]` | If set, run_terminal only runs these executables. |
| `azgovIde.blockNetworkCommands` | `false` | Block ad-hoc network/egress commands. |
| `azgovIde.autoModeAllowTerminal` | `false` | Allow shell without approval in Auto mode. |
| `azgovIde.redactSecrets` | `true` | Mask secrets in audit / cards / output. |
| `azgovIde.costBudgetUsd` | `0` | Per-chat USD ceiling (0 disables). |
| `azgovIde.auditEnabled` | `true` | Write the tamper-evident audit log. |
| `azgovIde.auditIngestionEndpoint` | `""` | DCE Logs Ingestion endpoint (off-box forwarding). |
| `azgovIde.auditDcrImmutableId` | `""` | Data Collection Rule immutable id. |

Full list and details: [packages/extension/README.md](packages/extension/README.md).

## Commands

Open the Command Palette and type "AzureGov":

- Ask... / Select model / Set (or clear) break-glass API key
- Verify audit log integrity / Open audit log
- Generate compliance evidence bundle
- Undo last agent file change

## Repository layout

```
packages/
  agents-client/     portable agent engine (AgentBrain + Responses adapter + loop), zero runtime deps
  extension/         VS Code extension (chat panel, local tools, auth, audit, evidence)
  create-azgov-ide/  guided installer (Bicep deploy + locked settings), zero deps
infra/
  main.bicep         resource-group stack: Azure OpenAI + PE, Log Analytics, DCE/DCR + roles
scripts/
  sign-vsix.ps1      SHA-256 + detached PKCS#7 signature for the VSIX
  verify-vsix.ps1    verify checksum + signature before sideloading
docs/
  SIGNING.md         signing / verification workflow
```

## Development

Node.js 20+ and npm workspaces.

```bash
npm ci            # install
npm run typecheck # type-check all packages
npm run build     # build agents-client + bundle the extension
npm test          # run all unit / integration suites (node:test)
```

Continuous integration (`.github/workflows/ci.yml`) type-checks, builds, and tests on Ubuntu and
Windows, then packages the VSIX as a build artifact. Test suites cover the security-critical
paths: the CUI boundary, the command-execution policy (denylist, allow-list, egress guard,
Auto-mode gate, chaining/substitution), secret redaction, the audit hash-chain and tamper
detection, prompt-injection framing, and the evidence control mapping.

## Signing and verifying the VSIX

For air-gapped / CMMC environments the VSIX is sideloaded rather than installed from a
marketplace. `scripts/sign-vsix.ps1` produces a SHA-256 manifest and an optional detached
PKCS#7 signature from your code-signing certificate; `scripts/verify-vsix.ps1` validates both
before install. Full workflow in [docs/SIGNING.md](docs/SIGNING.md).

## Status

Implemented and verified in an Azure US Government sandbox:

- [x] Azure OpenAI Responses API agent loop (function calling, streaming, store=false)
- [x] VS Code extension: chat panel, four modes, cost tracking, inline diffs and approvals
- [x] CUI boundary enforcement (endpoint pin, model allow-list, policy locks)
- [x] Tamper-evident, attributable audit log with off-box Log Analytics forwarding
- [x] Backend hardening (Private Endpoint, public network access disabled, local auth disabled)
- [x] Prompt-injection defense, command allow-list, egress guard, hard Auto-mode gate
- [x] Secret redaction, cost budget enforcement, one-click rollback
- [x] Machine-derived compliance evidence bundle (NIST 800-171 / CMMC L2)
- [x] Guided installer (create-azgov-ide) + Bicep IaC
- [x] Unit / integration tests, CI (Ubuntu + Windows), VSIX signing
- [ ] Marketplace / Open VSX publication and signed release bundle
- [ ] Modified / Limited Abuse Monitoring exemption (a Microsoft application form, per tenant)

## Contributing

Contributions are welcome. Because this tool is a compliance surface, the bar for changes that
touch the boundary, the command policy, the audit log, or redaction is high: include tests, and
expect security review. Please open an issue to discuss substantial changes first.

- Fork the repository and create a feature branch.
- `npm ci && npm run typecheck && npm run build && npm test` must pass.
- Keep documentation ASCII-only (no typographic dashes or smart quotes).
- Open a pull request against `main`.

Only the maintainer pushes to `main`; all other contributions come in through pull requests
from forks.

## Security policy

Do not open public issues for security vulnerabilities. Report them privately to
security@entropex.io (or via https://entropex.io). Please include a description, affected
version, and reproduction steps. We aim to acknowledge within a few business days.

## License

Apache License, Version 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Copyright 2026
Entropex, LLC.

## About Entropex

Entropex (https://entropex.io) builds and implements CMMC-compliant tooling. This project is
open source because compliant, inspectable tools are the fastest way to earn trust. If you need
help standing it up for real CUI - backend hardening, the audit pipeline, an abuse-monitoring
exemption, SSP authoring, or C3PAO assessment support - that is what Entropex does.
