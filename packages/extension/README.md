# AzureGov IDE Coding Assistant

An Azure-native VS Code coding agent for **CMMC / CUI** environments — a Claude-Code / Codex–style chat panel whose **code context never leaves the customer's Azure US Government boundary**.

The agent brain is the **Azure OpenAI Responses API in Azure US Government** (GPT models). It is *not* Claude — Azure Government has no Claude — but it gives the same chat + edit + agent experience, powered by GPT and fully in-boundary.

- 🛡 **Dedicated chat panel** in the activity bar (its own icon), with streaming responses, multi-turn history, and inline tool activity — no dependency on VS Code's built-in Chat view or Copilot.
- 🔒 **In-boundary by design** — tools run locally on your machine; only the model call crosses the wire, and it can go over an Azure **Private Endpoint** (`*.openai.azure.us`) with no internet egress.
- 🧠 **Model picker** — switch between a fast model and a deep-reasoning model per task.
- 🚫 **`store=false`** — no conversation/file state is persisted server-side.

---

## Requirements

- **VS Code** 1.95 or newer.
- An **Azure OpenAI resource in Azure US Government** with a chat-capable deployment (e.g. `gpt-4.1`, `gpt-5.1`) reachable from your machine (directly or over a Private Endpoint).
- Either a **break-glass API key** for that resource, **or** a Microsoft Entra identity with the **`Cognitive Services OpenAI User`** role for keyless auth.

---

## Install

**From a packaged VSIX**

1. Open the **Extensions** view (`Ctrl+Shift+X`).
2. Click the **`...`** menu → **Install from VSIX…**.
3. Select `azgov-ide-*.vsix`.
4. **Fully restart VS Code** (a cold start, not just *Reload Window*).

**From source (development)**

```bash
npm install
npm run build           # builds agents-client + bundles the extension
# then press F5 in VS Code (uses .vscode/launch.json) to launch the Extension Development Host
```

---

## Quick start

1. **Open a folder / workspace** — the agent operates on the open workspace.
2. Click the **🛡 shield icon** in the left **activity bar** to open the **AzureGov Agent** panel.
3. **Set authentication** (first message will prompt if it's missing):
   - *Break-glass key:* set `azgovIde.authMode` to `key`, run **AzureGov IDE: Set break-glass API key**, and paste the resource key.
   - *Keyless Entra (recommended):* set `azgovIde.authMode` to `entra`, set VS Code's `microsoft-sovereign-cloud.environment` to `AzureUSGovernment`, and assign your identity the **Cognitive Services OpenAI User** role on the resource.
4. **Type a request** in the panel's input box and press **Enter** (Shift+Enter for a newline). The answer streams back, with tool calls shown inline.
5. Click the **model pill** (top-right of the panel) to switch models by task complexity.

> Get the resource key with:
> `az cognitiveservices account keys list -g <rg> -n <account> --query key1 -o tsv`

---

## Commands

Open the Command Palette (`Ctrl+Shift+P`) and type **AzureGov**:

| Command | ID | What it does |
| --- | --- | --- |
| **AzureGov IDE: Ask…** | `azgovIde.ask` | Prompts for a question and streams the answer into an output pane (a non-panel entry point). |
| **AzureGov IDE: Select model** | `azgovIde.selectModel` | Quick-pick to switch the active model (`gpt-4.1` ↔ `gpt-5.1`). |
| **AzureGov IDE: Set break-glass API key** | `azgovIde.setApiKey` | Stores the Azure OpenAI API key in VS Code **SecretStorage** (encrypted). |
| **AzureGov IDE: Clear break-glass API key** | `azgovIde.clearApiKey` | Removes the stored API key. |

The status-bar **🛡 model** indicator also switches models when clicked.

---

## Settings

Configure under **Settings → Extensions → AzureGov IDE Coding Assistant**, or in `settings.json`:

| Setting | Default | Description |
| --- | --- | --- |
| `azgovIde.endpoint` | `https://aoai-azgov-ide.openai.azure.us` | Azure OpenAI **Gov** endpoint (`*.openai.azure.us`). |
| `azgovIde.model` | `gpt-4.1` | Model deployment to use. `gpt-4.1` (fast) or `gpt-5.1` (deep reasoning). |
| `azgovIde.authMode` | `entra` | `entra` (keyless Microsoft Entra ID) or `key` (break-glass API key from SecretStorage). |
| `azgovIde.tenantId` | `""` | Optional Entra tenant ID (GUID) to pin for keyless auth. |
| `azgovIde.store` | `false` | Persist server-side conversation state. **Keep `false` for CMMC/CUI.** |
| `azgovIde.approveWrites` | `true` | Require confirmation before file writes and terminal commands. |

Example `settings.json`:

```json
{
  "azgovIde.endpoint": "https://<your-resource>.openai.azure.us",
  "azgovIde.model": "gpt-4.1",
  "azgovIde.authMode": "key",
  "azgovIde.store": false,
  "azgovIde.approveWrites": true,
  "microsoft-sovereign-cloud.environment": "AzureUSGovernment"
}
```

---

## What the agent can do (tools)

The agent runs a function-calling loop and executes these tools **locally**, confined to the open workspace root:

| Tool | Access | Notes |
| --- | --- | --- |
| `list_dir` | read | List a directory. |
| `read_file` | read | Read a UTF-8 file (truncated ~60 KB). |
| `grep` | read | Regex search across workspace files. |
| `write_file` | **write** | Create/overwrite a file — **prompts for approval** when `approveWrites` is on. |
| `run_terminal` | **execute** | Run a shell command in the workspace root — **prompts for approval**; a denylist blocks destructive commands. |

**Safety model:** every path is confined to the workspace root (no `..` escapes); reads are automatic; writes and terminal commands require explicit approval; a denylist blocks patterns like `rm -rf`, `curl | sh`, and fork bombs.

---

## Authentication notes (Azure US Government)

Keyless Entra ID requires **Gov-specific** values (a commercial-cloud token is rejected with HTTP 401):

- Token audience: `https://cognitiveservices.azure.us/.default`
- Authority: `https://login.microsoftonline.us`
- VS Code auth provider: `microsoft-sovereign-cloud` (set `microsoft-sovereign-cloud.environment` = `AzureUSGovernment`)
- Least-privilege role: **Cognitive Services OpenAI User**

The break-glass API key is a fallback for development; production should disable local auth on the resource and use keyless Entra.

---

## Build & package

```bash
# from the repo root
npm install
npm run build

# package a VSIX (from packages/extension)
npx @vscode/vsce package --no-dependencies --allow-missing-repository -o azgov-ide.vsix
```

---

## Compliance posture (summary)

Maps to NIST SP 800-171 / CMMC L2: code context stays in the workspace (3.1.3 CUI flow control); the endpoint is reachable over a Private Endpoint with public access disabled (3.13.1); keyless Entra + least-privilege roles (3.1.x); TLS to the private endpoint (3.13.8/11). See the repository root README for the full architecture and compliance narrative.
