# AzureGov IDE Coding Assistant

An Azure-native VS Code coding agent for CMMC / CUI environments. The agent brain is the
Azure OpenAI Responses API in Azure US Government; code context never leaves the Gov
boundary.

Built and maintained by Entropex, LLC (https://entropex.io). Apache-2.0.

Not Claude: Azure Government has no Anthropic Claude, so this is GPT-powered via Azure
OpenAI Gov (gpt-5.1 / gpt-4.1). The value is the architecture, not the model.

- Dedicated chat panel in the activity bar, with streaming responses, four modes
  (Ask, Plan, Auto, Review), a thinking view, chat history, and per-message token and
  cost tracking.
- Local tool execution (read, list, grep, create folder, write, run terminal) confined
  to the workspace root, with human approval for writes and commands.
- Inline change cards with plus/minus diffs and Approve/Reject buttons. Auto mode applies
  without prompting.
- Auth: managed identity (no sign-in), keyless Entra device code, or a break-glass API
  key in SecretStorage.
- store=false: no conversation state persisted server-side.

## Requirements

- VS Code 1.95 or newer.
- An Azure OpenAI resource in Azure US Government with a chat-capable deployment
  (gpt-4.1, gpt-5.1) reachable from your machine (directly or over a Private Endpoint).
- Managed identity or an Entra identity with the "Cognitive Services OpenAI User" role,
  or a break-glass API key for the resource.

## Install

From a packaged VSIX:

1. Extensions view -> the ... menu -> Install from VSIX.
2. Select the azgov-ide vsix.
3. Fully restart VS Code (a cold start, not just Reload Window).

From source:

```bash
npm install
npm run build
# then press F5 in VS Code to launch the Extension Development Host
```

## Quick start

1. Open a folder or workspace.
2. Click the shield icon in the activity bar to open the AzureGov Agent panel.
3. Set authentication:
   - managed: nothing to do on an Azure VM whose identity holds the role.
   - entra: run a request; enter the device code on any machine.
   - key: set azgovIde.authMode to key, run "AzureGov IDE: Set break-glass API key".
4. Type a request and press Enter. Switch models with the model pill.

## Commands

Open the Command Palette and type AzureGov:

| Command | ID | What it does |
| --- | --- | --- |
| AzureGov IDE: Ask... | azgovIde.ask | Prompt for a question; stream the answer to an output pane. |
| AzureGov IDE: Select model | azgovIde.selectModel | Switch the active model (gpt-4.1 / gpt-5.1). |
| AzureGov IDE: Set break-glass API key | azgovIde.setApiKey | Store the API key in SecretStorage. |
| AzureGov IDE: Clear break-glass API key | azgovIde.clearApiKey | Remove the stored key and cached token. |
| AzureGov IDE: Verify audit log integrity | azgovIde.verifyAudit | Re-check the hash chain of the local audit log. |
| AzureGov IDE: Open audit log | azgovIde.openAudit | Open the local audit log (JSONL). |
| AzureGov IDE: Generate compliance evidence bundle | azgovIde.generateEvidence | Write a control-mapped evidence bundle (JSON + SSP excerpt). |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| azgovIde.endpoint | https://aoai-azgov-ide.openai.azure.us | Azure OpenAI Gov endpoint. |
| azgovIde.model | gpt-4.1 | Model deployment. gpt-4.1 (fast) or gpt-5.1 (deep reasoning). |
| azgovIde.authMode | managed | managed, entra (device code), or key. |
| azgovIde.tenantId | "" | Entra tenant id for keyless auth. |
| azgovIde.store | false | Persist server-side state. Keep false for CMMC/CUI. |
| azgovIde.approveWrites | true | Require confirmation before writes and commands (ignored in Auto mode). |
| azgovIde.autoCompactTokens | 100000 | Auto-compact the conversation past this size. 0 disables. Or type /compact. |
| azgovIde.pricing | {} | Per-model USD per 1,000,000 tokens, to estimate spend. |
| azgovIde.auditEnabled | true | Write the tamper-evident, hash-chained audit log. |
| azgovIde.auditIngestionEndpoint | "" | Logs Ingestion endpoint of a Data Collection Endpoint (Gov: *.ingest.monitor.azure.us). Set to forward off-box. |
| azgovIde.auditDcrImmutableId | "" | Immutable id of the Data Collection Rule that routes events to the workspace. |
| azgovIde.auditStreamName | Custom-AzgovIdeAudit_CL | Stream name declared in the DCR (matches the AzgovIdeAudit_CL table). |
| azgovIde.commandAllowlist | [] | If non-empty, run_terminal only runs these executables. |
| azgovIde.blockNetworkCommands | false | Block ad-hoc network/egress commands (curl, wget, scp, ssh, ...). |
| azgovIde.autoModeAllowTerminal | false | Allow run_terminal without approval in Auto mode. Off = shell still needs approval. |

## Audit and evidence

Because store=false means Azure keeps no conversation state, the client is the only
possible audit source, so the audit log is the load-bearing NIST SP 800-171 AU control
(3.3.1 / 3.3.2 / 3.3.8).

Every agent action (model calls, tool calls, file changes with before/after SHA-256,
approvals, per-turn cost/tokens, errors) is written to an append-only JSONL log under the
extension global storage. Each event is hash-chained to the previous one, so any edit,
insertion, or deletion is detectable. Run "AzureGov IDE: Verify audit log integrity" to
re-check the chain. Each event is attributed to the resolved Entra identity (managed
identity object id, or the signed-in user) so actions trace to an individual.

Optional off-box forwarding: set auditIngestionEndpoint and auditDcrImmutableId to send a
second, independent copy of every event to a Log Analytics workspace via the Azure Monitor
Logs Ingestion API. This keeps the trail even if the workstation is compromised (3.3.8,
protect audit information). Forwarding is best-effort and never blocks the agent; the full
hash-chained event is carried in the RawEvent column so the off-box copy stays verifiable.
The signing identity needs the "Monitoring Metrics Publisher" role on the Data Collection
Rule. In Azure US Government the Monitor scope is https://monitor.azure.us. Provision the
Data Collection Endpoint, custom table (AzgovIdeAudit_CL), and Data Collection Rule with
your workspace, then set the three settings above (org admins can lock them via policy).

Evidence bundle: run "AzureGov IDE: Generate compliance evidence bundle" to write a
control-mapped report (JSON plus a human-readable SSP excerpt) into an azgov-evidence
folder. It is derived from the tool's live, effective configuration and audit state
(including a fresh audit-chain verification), mapped to NIST SP 800-171 / CMMC L2. It is
a starting point for an assessment, not a certification.

## Tools and safety

The agent executes these tools locally, confined to the workspace root:

| Tool | Access | Notes |
| --- | --- | --- |
| list_dir | read | List a directory. |
| read_file | read | Read a UTF-8 file (truncated). |
| grep | read | Regex search across the workspace. |
| create_folder | write | Create a directory (approval unless Auto). |
| write_file | write | Create or overwrite a file; shows a diff (approval unless Auto). |
| run_terminal | execute | Run a command; background flag for servers; 120s timeout; process-tree kill. |

Safety: workspace-root confinement (no .. escapes), human approval for writes and
commands, and a command denylist (rm -rf, curl | sh, fork bombs).

Injection and exfiltration defense:

- Untrusted output: every tool result (file contents, command output, API/web
  responses) is framed to the model as data, and the system prompt forbids obeying
  any instructions embedded in it. This is the primary defense against prompt
  injection (the "lethal trifecta" of untrusted content, code execution, and
  exfiltration).
- Command allowlist (azgovIde.commandAllowlist): if set, run_terminal only runs
  allowlisted executables (for example az, git, terraform, npm, python).
- Egress guard (azgovIde.blockNetworkCommands): blocks ad-hoc network tools (curl,
  wget, scp, ssh, nc, and similar) so CUI cannot leave the boundary. Package managers
  and Azure CLI are unaffected.
- Hard Auto-mode gate (azgovIde.autoModeAllowTerminal): Auto mode auto-applies file
  edits, but shell commands still require approval unless allowlisted, so a prompt
  injection cannot silently run commands. Off by default.

## Build and package

```bash
npm install
npm run build
npx @vscode/vsce package --no-dependencies --allow-missing-repository -o azgov-ide.vsix
```

## License

Apache-2.0. Commercial CMMC implementation and assessment support: https://entropex.io.
