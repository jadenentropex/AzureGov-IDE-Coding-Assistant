# AzureGov-IDE-Coding-Assistant

An Azure-native, VS Code AI coding assistant for **CMMC Level 2 / CUI** organizations — a Claude-Code-like experience (chat + edit + agent) whose **code context never leaves the customer's Azure US Government boundary**.

> **Not Claude.** Azure Government has no Anthropic Claude. This is GPT-powered via **Azure OpenAI in Azure Government** (gpt-5.1 / gpt-4.1). The value is the *architecture*: the tool is the compliance surface, not the model.

## Architecture

```
VS Code extension (client)                Azure US Government boundary
  ├─ Chat Participant UI                   ┌───────────────────────────────┐
  ├─ local tool executors  ───────────────┤ Azure OpenAI Responses API    │
  │   (read/write/grep/run, in workspace)  │  *.openai.azure.us  gpt-4.1   │
  ├─ keyless Entra auth (.us audience)     │  store=false → no CUI at rest │
  └─ agents-client (AgentBrain loop) ──────┤ (Private Endpoint, PE-only)   │
                                           └───────────────────────────────┘
   code/tools run locally — only the model call crosses the wire
```

**Engine = Azure OpenAI Responses API** (verified live in Gov: function-calling + streaming + `store=false`). The classic Assistants API is intentionally **not** used — it retires 2026-08-26. A Microsoft Foundry Agent Service adapter can slot in later behind the same `AgentBrain` interface.

## Compliance posture (NIST SP 800-171 / CMMC L2)

- **3.1.3 CUI flow control** — `store=false` keeps conversation/file state out of Microsoft's managed store; tools execute locally so source stays on the workstation; only the model call crosses the boundary.
- **3.13.1 boundary protection** — resource is Private-Endpoint-only (`privatelink.openai.azure.us`), public network access disabled.
- **3.13.x / 3.1.x** — keyless Entra ID (audience `https://cognitiveservices.azure.us/.default`, authority `login.microsoftonline.us`), `disableLocalAuth`, least-privilege `Cognitive Services OpenAI User` role.
- **3.3.x audit** — diagnostic logs to a Gov Log Analytics workspace; local tool-approval log.
- Ops prerequisites: Modified Abuse Monitoring approval; confirm the FedRAMP/IL boundary with your Microsoft account team.

## Repo layout

```
packages/
  agents-client/   # portable agent brain — AgentBrain + ResponsesAdapter + agent loop (zero runtime deps)
  extension/       # VS Code extension (Chat Participant UI, local tools, auth)
```

## Develop

```bash
npm install
npm run build
# Smoke-test the agent loop against Gov (break-glass key; production uses keyless Entra):
AZURE_OPENAI_API_KEY=<key> npm run smoke
```

The smoke test drives the real Responses API in Gov through a full `list_dir` → `read_file` → grounded-answer loop against a temp workspace.

### Run the extension

1. `npm install && npm run build`
2. Press **F5** (or Run → "Run AzureGov IDE Extension") to launch the Extension Development Host.
3. Open a folder, open the Chat view, and talk to **`@azgov`** (try `@azgov /explain` with a file open).
4. Auth — pick one:
   - **Break-glass key (fastest):** set `azgovIde.authMode` = `key`, run **AzureGov IDE: Set break-glass API key**, paste the resource key.
   - **Keyless Entra (recommended):** set `azgovIde.authMode` = `entra`, set `microsoft-sovereign-cloud.environment` = `AzureUSGovernment`, and assign your identity the **Cognitive Services OpenAI User** role on the resource.
5. Switch models (gpt-4.1 ↔ gpt-5.1) from the status-bar shield or **AzureGov IDE: Select model**.

## Status

- [x] Azure OpenAI provisioned + verified in Azure US Government (usgovvirginia)
- [x] Models deployed & verified: **gpt-4.1** (Standard) + **gpt-5.1** (DataZone) — user-selectable by complexity
- [x] Responses API agent loop verified live: function-calling + streaming + `store=false`
- [x] `agents-client` — AgentBrain, ResponsesAdapter, agent loop (builds + smoke-passes against Gov)
- [x] VS Code extension — Chat Participant `@azgov`, local tools, model picker, key + keyless-Entra auth (builds + activates)
- [ ] M1: keyless Entra click-test (assign **Cognitive Services OpenAI User**, set `microsoft-sovereign-cloud.environment`)
- [ ] Backend hardening (PE-only, disableLocalAuth, Log Analytics audit)
