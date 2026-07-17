# create-azgov-ide

Guided installer for the AzureGov IDE Coding Assistant. It stands up the in-boundary Azure
US Government stack (Azure OpenAI + optional private endpoint, Log Analytics, and the audit
Data Collection Endpoint / Data Collection Rule) from a set of setup questions, then writes a
locked `.vscode/settings.json` pinning the extension to the freshly deployed Gov endpoint and
audit pipeline.

## Requirements

- Azure CLI installed and logged in to Azure US Government (`az cloud set --name AzureUSGovernment`, then `az login`).
- Rights to create resources and role assignments in the target subscription.
- Node.js 18 or newer. No npm dependencies.

## Use

```bash
# interactive
node index.js

# non-interactive (see answers.example.json)
node index.js --config answers.json

# print the plan and the settings it would write, deploy nothing
node index.js --dry-run --config answers.json
```

The installer pins the cloud and subscription on every Azure CLI call (the CLI is known to
drift between clouds/subscriptions), creates the resource group if needed, deploys
`infra/main.bicep`, reads the deployment outputs, and writes the settings below.

## What it writes

`.vscode/settings.json` (existing file is backed up to `.bak` and merged):

- `azgovIde.endpoint` - the deployed Gov endpoint
- `azgovIde.authMode` - managed (VM managed identity) by default
- `azgovIde.store` - false (no CUI at rest in the service)
- `azgovIde.approveWrites` - true
- `azgovIde.auditEnabled` - true
- `azgovIde.auditIngestionEndpoint`, `azgovIde.auditDcrImmutableId`, `azgovIde.auditStreamName` - the audit pipeline
- `azgovIde.allowedModels` - the deployed model names
- optional `azgovIde.commandAllowlist`, `azgovIde.blockNetworkCommands`, `azgovIde.tenantId`

For org-wide enforcement, push the same keys as policy (GPO/Intune) instead of a settings
file. See the extension README for the policy-lockable settings.

## Infrastructure

`infra/main.bicep` (resource-group scope) deploys: the Azure OpenAI account (system-assigned
identity, local auth disabled, public access disabled when a private endpoint is requested),
the model deployments, an optional private endpoint + private DNS zone
(`privatelink.openai.azure.us`), a Log Analytics workspace, diagnostic settings, the audit
Data Collection Endpoint, the `AzgovIdeAudit_CL` custom table, the Data Collection Rule, and
the two role assignments the calling identity needs (Cognitive Services OpenAI User on the
account, Monitoring Metrics Publisher on the rule).
