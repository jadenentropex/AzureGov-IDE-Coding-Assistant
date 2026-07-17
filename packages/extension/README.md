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

## Build and package

```bash
npm install
npm run build
npx @vscode/vsce package --no-dependencies --allow-missing-repository -o azgov-ide.vsix
```

## License

Apache-2.0. Commercial CMMC implementation and assessment support: https://entropex.io.
