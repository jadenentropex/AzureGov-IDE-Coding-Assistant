// AzureGov IDE Coding Assistant - in-boundary infrastructure (Azure US Government).
//
// Stands up everything the extension needs to run inside a CMMC/CUI boundary:
//   - Azure OpenAI account (Gov data plane) + model deployments, system-assigned identity,
//     optional private endpoint, local-auth disabled, public network access disabled.
//   - Log Analytics workspace + Data Collection Endpoint + custom table + Data Collection Rule
//     for the off-box, tamper-evident audit trail.
//   - Diagnostic settings and the two role assignments the calling identity needs.
//
// Deploy at resource-group scope. See create-azgov-ide (the install wizard) for a guided flow.

targetScope = 'resourceGroup'

@description('Azure US Government region.')
param location string = resourceGroup().location

@description('Base name; resource names derive from it.')
@minLength(3)
@maxLength(20)
param namePrefix string = 'azgov-ide'

@description('Model deployments to create. capacity is in thousands of TPM; sku is Standard or DataZoneStandard.')
param deployments array = [
  { name: 'gpt-4.1', version: '2025-04-14', sku: 'Standard', capacity: 50 }
  { name: 'gpt-5.1', version: '2025-11-13', sku: 'DataZoneStandard', capacity: 200 }
]

@description('Object id of the identity that will call the model and forward audit (VM managed identity or a user). Leave empty to skip role assignments.')
param callerPrincipalId string = ''

@description('Principal type for the role assignments.')
@allowed([ 'ServicePrincipal', 'User', 'Group' ])
param callerPrincipalType string = 'ServicePrincipal'

@description('Deploy a private endpoint for the Azure OpenAI account. Requires an existing subnet.')
param deployPrivateEndpoint bool = false

@description('Resource id of an existing subnet for the private endpoint (required when deployPrivateEndpoint is true).')
param privateEndpointSubnetId string = ''

@description('Disable local (api-key) auth on the Azure OpenAI account. Recommended for CMMC.')
param disableLocalAuth bool = true

@description('Audit retention in the custom table (days).')
param auditRetentionDays int = 365

var aoaiName = 'aoai-${namePrefix}'
var lawName = 'law-${namePrefix}'
var dceName = 'dce-${namePrefix}-audit'
var dcrName = 'dcr-${namePrefix}-audit'
var tableName = 'AzgovIdeAudit_CL'
var streamName = 'Custom-AzgovIdeAudit_CL'
var govDnsZone = 'privatelink.openai.azure.us'

// Built-in role definition ids (same GUIDs in Gov).
var roleOpenAiUser = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd') // Cognitive Services OpenAI User
var roleMetricsPublisher = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '3913510d-42f4-4e42-8a64-420c390055eb') // Monitoring Metrics Publisher

// Audit table columns (one source of truth; mapped to the two required type spellings).
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

resource law 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: lawName
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 90
  }
}

resource aoai 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: aoaiName
  location: location
  kind: 'OpenAI'
  sku: { name: 'S0' }
  identity: { type: 'SystemAssigned' }
  properties: {
    customSubDomainName: aoaiName
    publicNetworkAccess: deployPrivateEndpoint ? 'Disabled' : 'Enabled'
    disableLocalAuth: disableLocalAuth
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

resource aoaiDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-law'
  scope: aoai
  properties: {
    workspaceId: law.id
    logs: [ { categoryGroup: 'audit', enabled: true }, { categoryGroup: 'allLogs', enabled: true } ]
    metrics: [ { category: 'AllMetrics', enabled: true } ]
  }
}

// ---- Private endpoint (optional) ----
resource pe 'Microsoft.Network/privateEndpoints@2023-11-01' = if (deployPrivateEndpoint) {
  name: 'pe-${aoaiName}'
  location: location
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [ {
      name: 'aoai'
      properties: { privateLinkServiceId: aoai.id, groupIds: [ 'account' ] }
    } ]
  }
}

resource dnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = if (deployPrivateEndpoint) {
  name: govDnsZone
  location: 'global'
}

resource dnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = if (deployPrivateEndpoint) {
  parent: dnsZone
  name: 'vnet-link'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: split(privateEndpointSubnetId, '/subnets/')[0] }
  }
}

resource peDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = if (deployPrivateEndpoint) {
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

// ---- Role assignments for the calling identity ----
resource raOpenAi 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(callerPrincipalId)) {
  name: guid(aoai.id, callerPrincipalId, 'openai-user')
  scope: aoai
  properties: {
    roleDefinitionId: roleOpenAiUser
    principalId: callerPrincipalId
    principalType: callerPrincipalType
  }
}

resource raMetrics 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(callerPrincipalId)) {
  name: guid(dcr.id, callerPrincipalId, 'metrics-publisher')
  scope: dcr
  properties: {
    roleDefinitionId: roleMetricsPublisher
    principalId: callerPrincipalId
    principalType: callerPrincipalType
  }
}

output openAiEndpoint string = aoai.properties.endpoint
output openAiAccountName string = aoai.name
output workspaceId string = law.properties.customerId
output auditIngestionEndpoint string = dce.properties.logsIngestion.endpoint
output auditDcrImmutableId string = dcr.properties.immutableId
output auditStreamName string = streamName
