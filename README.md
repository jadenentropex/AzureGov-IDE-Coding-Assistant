# AzureGov IDE Coding Assistant

An Azure-native, in-boundary AI coding assistant for CMMC Level 2 / CUI organizations.
It gives a Claude-Code / Codex style chat, edit, and agent experience while keeping
code context inside the customer's authorized Azure US Government boundary.

Built and maintained by Entropex, LLC (https://entropex.io). Free and open source
under the Apache License, Version 2.0.

> Not Claude. Azure Government has no Anthropic Claude. The agent is GPT-powered via
> Azure OpenAI in Azure Government (gpt-5.1 / gpt-4.1). The value is the architecture:
> the tool is the compliance surface, not the model.

## Architecture

```
VS Code extension (client)                Azure US Government boundary
  - chat panel (activity-bar view)         +-------------------------------+
  - local tool executors  ---------------> | Azure OpenAI Responses API    |
    (read/write/grep/run, in workspace)    |  *.openai.azure.us  gpt-4.1   |
  - managed-identity / Entra / key auth    |  store=false: no CUI at rest  |
  - agents-client (agent loop) ----------> | (Private Endpoint, PE-only)   |
                                           +-------------------------------+
   code and tools run locally; only the model call crosses the wire
```

The engine is the Azure OpenAI Responses API (verified live in Gov: function calling,
streaming, and store=false). Tools execute locally in the developer workspace, so
source code stays on the machine and only the model call leaves.

## How it works

- Dedicated chat panel with streaming responses, four modes (Ask, Plan, Auto, Review),
  a thinking view, and per-message token and cost tracking.
- Local tools, confined to the workspace root: list_dir, read_file, grep, create_folder,
  write_file, and run_terminal (with a background flag, a 120s timeout, process-tree
  kill, and a command denylist).
- Inline change cards with plus/minus diffs and Approve/Reject buttons (no OS popups).
  Auto mode applies changes without prompting.
- Chat history, auto-compaction of long conversations, retry on transient errors, and a
  message queue so you can add context while a turn runs.

## Authentication (Azure US Government)

- managed: the Azure VM's managed identity via the local metadata endpoint. No sign-in.
- entra: keyless device-code flow (Gov audience cognitiveservices.azure.us/.default,
  authority login.microsoftonline.us).
- key: break-glass API key stored in VS Code SecretStorage.

The identity needs the "Cognitive Services OpenAI User" role on the resource.

## Compliance posture (NIST SP 800-171 / CMMC L2)

- 3.1.3 CUI flow control: store=false keeps conversation state out of Azure; tools run
  locally so source stays on the workstation; only the model call crosses the boundary.
- 3.13.1 boundary protection: the resource is reachable over a Private Endpoint
  (privatelink.openai.azure.us) with public network access disabled.
- 3.13.x / 3.1.x: keyless Entra or managed identity, least-privilege roles, FIPS TLS.
- 3.3.x audit: diagnostic logs to a Gov Log Analytics workspace (in progress).

This repository is a starting point. Standing it up for real CUI requires the backend
hardening, audit pipeline, and evidence artifacts described in the roadmap. Entropex
provides implementation and assessment support (see Commercial support below).

## Repo layout

```
packages/
  agents-client/   portable agent engine (AgentBrain + Responses adapter + loop), no runtime deps
  extension/       VS Code extension (chat panel, local tools, auth)
```

## Develop

```bash
npm install
npm run build
# Smoke-test the agent loop against Gov (break-glass key; production uses keyless auth):
AZURE_OPENAI_API_KEY=<key> npm run smoke
```

## Status

- [x] Azure OpenAI provisioned and verified in Azure US Government
- [x] Responses API agent loop: function calling, streaming, store=false
- [x] agents-client engine and VS Code extension (chat panel, modes, cost, diffs, approvals)
- [ ] Attributable audit log and Log Analytics forwarding
- [ ] Endpoint pinning and org policy lock
- [ ] Backend hardening (PE-only, disableLocalAuth, abuse-monitoring exemption)
- [ ] SSP / evidence bundle generator and the guided install wizard

## Commercial support

Entropex offers implementation, hardening (PE-only, disableLocalAuth, audit pipeline),
managed service, custom functionality, and CMMC SSP authoring and assessment support.
See https://entropex.io.

## License

Apache-2.0. See LICENSE and NOTICE.
