# One-click POC deployment (Azure Government portal)

Deploy a self-contained proof of concept of the AzureGov IDE Coding Assistant into your own
Azure US Government subscription from the portal - no local tooling, no CLI, no bootstrap on your
machine. The portal deploys everything server-side; you just sign in and fill a short form.

## What gets deployed

Into a resource group you choose, in your subscription:

- A virtual network (self-contained; nothing pre-existing required) with a private-endpoint
  subnet and a VM subnet, and an NSG that allows RDP only from the source IP you provide.
- An Azure OpenAI account, private-endpoint only (`publicNetworkAccess=Disabled`,
  `disableLocalAuth=true`), with a private DNS zone (`privatelink.openai.azure.us`), and the
  gpt-4.1 and gpt-5.1 model deployments.
- A Log Analytics workspace, Azure OpenAI diagnostic settings, and the audit ingestion pipeline
  (Data Collection Endpoint, the `AzgovIdeAudit_CL` custom table, and a Data Collection Rule).
- A Windows dev VM with a system-assigned managed identity. On first boot it bootstraps VS Code,
  the extension (built from source), and the developer toolchain (git, Node, Azure CLI, Python,
  Terraform), and pre-seeds VS Code settings pointing at the deployed endpoint and audit pipeline.
- Two role assignments: the VM's managed identity gets Cognitive Services OpenAI User on the
  account and Monitoring Metrics Publisher on the Data Collection Rule. That managed identity is
  the keyless auth path - no keys are placed on the box.

## Before you start

- An Azure US Government subscription and permission to create resources and role assignments.
- Quota in your target region for: the gpt-4.1 (Standard) and gpt-5.1 (DataZoneStandard) model
  capacities, and the VM family you pick (for example DSv5 cores). Fresh subscriptions usually
  have quota; if a deployment fails with a quota error, request an increase or lower the sizes.
- Your workstation public IP, to allow RDP to the dev VM.

## Deploy

Click the button, sign into your tenant, and complete the form (subscription, resource group,
region, name prefix, admin credentials, VM size, allowed RDP source IP):

[![Deploy to Azure Government](https://aka.ms/deploytoazurebutton)](https://portal.azure.us/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fjadenentropex%2FAzureGov-IDE-Coding-Assistant%2Fmain%2Finfra%2Fpoc.json/createUIDefinitionUri/https%3A%2F%2Fraw.githubusercontent.com%2Fjadenentropex%2FAzureGov-IDE-Coding-Assistant%2Fmain%2Finfra%2FcreateUiDefinition.json)

The template and portal form are served from this repository:
`infra/poc.json` (compiled from `infra/poc.bicep`) and `infra/createUiDefinition.json`.

## After it deploys

1. The deployment finishes in a few minutes, but the VM bootstrap keeps running for roughly
   10-20 minutes as it installs VS Code, the toolchain, and builds the extension. Progress is
   logged on the VM at `C:\azgov\bootstrap.log`.
2. RDP to the dev VM's public IP (shown in the deployment outputs) with the admin credentials.
3. At first logon the extension installs automatically and VS Code opens. The AzureGov panel is
   in the activity bar; auth is the VM's managed identity, already pointed at the endpoint.
4. Ask the agent to do something, then run "AzureGov IDE: Generate compliance evidence bundle" to
   see the control-mapped report the tool produces from the live deployment.

## Cost and teardown

The POC runs real resources (a VM, an Azure OpenAI account, Log Analytics). To stop all charges,
delete the resource group you deployed into. Everything the POC created lives in that one group.

## Security notes

- RDP is restricted by NSG to the single source IP/CIDR you enter. For anything beyond a short
  POC, front the VM with Azure Bastion or a private link instead of public RDP.
- The dev VM reaches the model over the private endpoint; the account has public network access
  disabled and local (key) auth disabled. The keyless managed identity is the only auth path.
- This is a proof of concept. Production use adds the abuse-monitoring exemption, hardened
  network controls, and your System Security Plan. See the main README and https://entropex.io.
