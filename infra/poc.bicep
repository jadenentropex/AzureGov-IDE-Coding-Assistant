// AzureGov IDE Coding Assistant - turnkey POC (Azure US Government).
//
// A self-contained proof-of-concept a prospective client can deploy from the Azure Government
// portal ("Deploy to Azure") with no local tooling: it creates its own virtual network, the
// in-boundary Azure OpenAI backend (private-endpoint only), the tamper-evident audit pipeline,
// and - optionally - a ready-to-use Windows dev VM that bootstraps VS Code, this extension, and
// the developer tooling and points itself at the freshly deployed endpoint.
//
// Deploy at resource-group scope (the portal createUiDefinition supplies subscription/RG/region).

targetScope = 'resourceGroup'

@description('Azure US Government region.')
param location string = resourceGroup().location

@description('Base name; resource names derive from it.')
@minLength(3)
@maxLength(18)
param namePrefix string = 'azgov-poc'

@description('Model deployments. capacity is in thousands of TPM; sku is Standard or DataZoneStandard.')
param deployments array = [
  { name: 'gpt-4.1', version: '2025-04-14', sku: 'Standard', capacity: 50 }
  { name: 'gpt-5.1', version: '2025-11-13', sku: 'DataZoneStandard', capacity: 200 }
]

@description('VM size for the dev box.')
param vmSize string = 'Standard_D4s_v5'

@description('Dev VM local administrator username.')
param adminUsername string = 'azgovadmin'

@description('Dev VM local administrator password.')
@secure()
param adminPassword string

@description('Source IP or CIDR allowed to RDP to the dev VM (for example 203.0.113.5/32).')
param allowedRdpSourceIp string

@description('Public git repo the VM bootstrap clones to build and install the extension.')
param repoUrl string = 'https://github.com/jadenentropex/AzureGov-IDE-Coding-Assistant.git'

@description('Raw URL of the VM bootstrap script.')
param bootstrapScriptUri string = 'https://raw.githubusercontent.com/jadenentropex/AzureGov-IDE-Coding-Assistant/main/infra/bootstrap-devvm.ps1'

@description('Audit retention in the custom table (days).')
param auditRetentionDays int = 365

var aoaiName = 'aoai-${namePrefix}'
var lawName = 'law-${namePrefix}'
var dceName = 'dce-${namePrefix}-audit'
var dcrName = 'dcr-${namePrefix}-audit'
var tableName = 'AzgovIdeAudit_CL'
var streamName = 'Custom-AzgovIdeAudit_CL'
var govDnsZone = 'privatelink.openai.azure.us'
var vmName = take('vm-${namePrefix}', 15)

var roleOpenAiUser = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd') // Cognitive Services OpenAI User
var roleMetricsPublisher = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '3913510d-42f4-4e42-8a64-420c390055eb') // Monitoring Metrics Publisher

var cols = [
  { name: 'TimeGenerated', t: 'datetime' }
  { name: 'Seq', t: 'long' }
  { name: 'SessionId', t: 'string' }
  { name: 'EventType', t: 'string' }
  { name: 'ActorSource', t: 'string' }
  { name: 'ActorOid', t: 'string' }
  { name: 'ActorUpn', t: 'string' }
  { name: 'ActorName', t: 'string' }
  { name: 'ActorTenantId', t: 'string' }
  { name: 'AppId', t: 'string' }
  { name: 'MiResource', t: 'string' }
  { name: 'Host', t: 'string' }
  { name: 'Model', t: 'string' }
  { name: 'Endpoint', t: 'string' }
  { name: 'Mode', t: 'string' }
  { name: 'ResponseId', t: 'string' }
  { name: 'Tool', t: 'string' }
  { name: 'ToolArgs', t: 'string' }
  { name: 'ToolResult', t: 'string' }
  { name: 'ChangeId', t: 'string' }
  { name: 'ChangeKind', t: 'string' }
  { name: 'ChangePath', t: 'string' }
  { name: 'Command', t: 'string' }
  { name: 'LinesAdded', t: 'long' }
  { name: 'LinesRemoved', t: 'long' }
  { name: 'BeforeSha', t: 'string' }
  { name: 'AfterSha', t: 'string' }
  { name: 'NeedsApproval', t: 'bool' }
  { name: 'Approved', t: 'bool' }
  { name: 'Ok', t: 'bool' }
  { name: 'Rejected', t: 'bool' }
  { name: 'ExitCode', t: 'long' }
  { name: 'ErrorMessage', t: 'string' }
  { name: 'InputTokens', t: 'long' }
  { name: 'OutputTokens', t: 'long' }
  { name: 'CostUsd', t: 'real' }
  { name: 'Steps', t: 'long' }
  { name: 'Messages', t: 'long' }
  { name: 'Hash', t: 'string' }
  { name: 'PrevHash', t: 'string' }
  { name: 'RawEvent', t: 'string' }
]
var tableTypes = { datetime: 'dateTime', long: 'long', real: 'real', bool: 'boolean', string: 'string' }
var streamTypes = { datetime: 'datetime', long: 'long', real: 'real', bool: 'boolean', string: 'string' }
var tableColumns = map(cols, c => { name: c.name, type: tableTypes[c.t] })
var streamColumns = map(cols, c => { name: c.name, type: streamTypes[c.t] })

// ---- Network (self-contained) ----
resource nsg 'Microsoft.Network/networkSecurityGroups@2023-11-01' = {
  name: 'nsg-${namePrefix}-vm'
  location: location
  properties: {
    securityRules: [
      {
        name: 'allow-rdp-from-client'
        properties: {
          priority: 300
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: empty(allowedRdpSourceIp) ? '127.0.0.1/32' : allowedRdpSourceIp
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '3389'
        }
      }
    ]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' = {
  name: 'vnet-${namePrefix}'
  location: location
  properties: {
    addressSpace: { addressPrefixes: [ '10.20.0.0/16' ] }
    subnets: [
      {
        name: 'snet-pe'
        properties: {
          addressPrefix: '10.20.1.0/24'
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
      {
        name: 'snet-vm'
        properties: {
          addressPrefix: '10.20.2.0/24'
          networkSecurityGroup: { id: nsg.id }
        }
      }
    ]
  }
}

// ---- Azure OpenAI (private-endpoint only) ----
resource aoai 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: aoaiName
  location: location
  kind: 'OpenAI'
  sku: { name: 'S0' }
  identity: { type: 'SystemAssigned' }
  properties: {
    customSubDomainName: aoaiName
    publicNetworkAccess: 'Disabled'
    disableLocalAuth: true
  }
}

@batchSize(1)
resource modelDeployments 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = [for d in deployments: {
  parent: aoai
  name: d.name
  sku: { name: d.sku, capacity: d.capacity }
  properties: {
    model: { format: 'OpenAI', name: d.name, version: d.version }
  }
}]

resource law 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: lawName
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 90
  }
}

resource aoaiDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-law'
  scope: aoai
  properties: {
    workspaceId: law.id
    logs: [ { categoryGroup: 'audit', enabled: true }, { categoryGroup: 'allLogs', enabled: true } ]
    metrics: [ { category: 'AllMetrics', enabled: true } ]
  }
}

resource pe 'Microsoft.Network/privateEndpoints@2023-11-01' = {
  name: 'pe-${aoaiName}'
  location: location
  properties: {
    subnet: { id: '${vnet.id}/subnets/snet-pe' }
    privateLinkServiceConnections: [ {
      name: 'aoai'
      properties: { privateLinkServiceId: aoai.id, groupIds: [ 'account' ] }
    } ]
  }
}

resource dnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: govDnsZone
  location: 'global'
}

resource dnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: dnsZone
  name: 'vnet-link'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: vnet.id }
  }
}

resource peDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = {
  parent: pe
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [ { name: 'openai', properties: { privateDnsZoneId: dnsZone.id } } ]
  }
}

// ---- Audit ingestion pipeline ----
resource dce 'Microsoft.Insights/dataCollectionEndpoints@2023-03-11' = {
  name: dceName
  location: location
  properties: { networkAcls: { publicNetworkAccess: 'Enabled' } }
}

resource auditTable 'Microsoft.OperationalInsights/workspaces/tables@2022-10-01' = {
  parent: law
  name: tableName
  properties: {
    schema: { name: tableName, columns: tableColumns }
    retentionInDays: 90
    totalRetentionInDays: auditRetentionDays
  }
}

resource dcr 'Microsoft.Insights/dataCollectionRules@2023-03-11' = {
  name: dcrName
  location: location
  properties: {
    dataCollectionEndpointId: dce.id
    streamDeclarations: {
      '${streamName}': { columns: streamColumns }
    }
    destinations: {
      logAnalytics: [ { workspaceResourceId: law.id, name: 'law' } ]
    }
    dataFlows: [ {
      streams: [ streamName ]
      destinations: [ 'law' ]
      transformKql: 'source'
      outputStream: streamName
    } ]
  }
  dependsOn: [ auditTable ]
}

// ---- Dev VM (optional) ----
resource pip 'Microsoft.Network/publicIPAddresses@2023-11-01' = {
  name: 'pip-${vmName}'
  location: location
  sku: { name: 'Standard' }
  properties: { publicIPAllocationMethod: 'Static' }
}

resource nic 'Microsoft.Network/networkInterfaces@2023-11-01' = {
  name: 'nic-${vmName}'
  location: location
  properties: {
    ipConfigurations: [ {
      name: 'ipconfig1'
      properties: {
        subnet: { id: '${vnet.id}/subnets/snet-vm' }
        privateIPAllocationMethod: 'Dynamic'
        publicIPAddress: { id: pip.id }
      }
    } ]
  }
}

resource vm 'Microsoft.Compute/virtualMachines@2023-09-01' = {
  name: vmName
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    hardwareProfile: { vmSize: vmSize }
    osProfile: {
      computerName: vmName
      adminUsername: adminUsername
      adminPassword: adminPassword
    }
    storageProfile: {
      imageReference: {
        publisher: 'MicrosoftWindowsServer'
        offer: 'WindowsServer'
        sku: '2022-datacenter-azure-edition'
        version: 'latest'
      }
      osDisk: { createOption: 'FromImage', managedDisk: { storageAccountType: 'Premium_LRS' } }
    }
    networkProfile: { networkInterfaces: [ { id: nic.id } ] }
  }
}

resource bootstrap 'Microsoft.Compute/virtualMachines/extensions@2023-09-01' = {
  parent: vm
  name: 'bootstrap'
  location: location
  properties: {
    publisher: 'Microsoft.Compute'
    type: 'CustomScriptExtension'
    typeHandlerVersion: '1.10'
    autoUpgradeMinorVersion: true
    settings: {
      fileUris: [ bootstrapScriptUri ]
      commandToExecute: 'powershell -ExecutionPolicy Bypass -File bootstrap-devvm.ps1 -Endpoint "${aoai.properties.endpoint}" -DceIngest "${dce.properties.logsIngestion.endpoint}" -DcrId "${dcr.properties.immutableId}" -Stream "${streamName}" -RepoUrl "${repoUrl}" -AdminUser "${adminUsername}"'
    }
  }
}

// ---- Role assignments for the VM managed identity ----
resource raOpenAi 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(aoai.id, vmName, 'openai-user')
  scope: aoai
  properties: {
    roleDefinitionId: roleOpenAiUser
    principalId: vm.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource raMetrics 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(dcr.id, vmName, 'metrics-publisher')
  scope: dcr
  properties: {
    roleDefinitionId: roleMetricsPublisher
    principalId: vm.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output openAiEndpoint string = aoai.properties.endpoint
output workspaceId string = law.properties.customerId
output auditIngestionEndpoint string = dce.properties.logsIngestion.endpoint
output auditDcrImmutableId string = dcr.properties.immutableId
output auditStreamName string = streamName
output devVmName string = vmName
output devVmPublicIp string = pip.properties.ipAddress
