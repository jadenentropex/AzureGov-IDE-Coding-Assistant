#!/usr/bin/env node
/*
 * create-azgov-ide - guided installer for the AzureGov IDE Coding Assistant.
 *
 * Stands up the in-boundary Azure stack (infra/main.bicep) with a thorough set of setup
 * questions, then writes a locked .vscode/settings.json so the extension is pinned to the
 * freshly deployed Gov endpoint + audit pipeline. Zero npm dependencies: it drives the Azure
 * CLI, which the operator must already have installed and be logged in to (Azure US Government).
 *
 * Usage:
 *   node index.js                      interactive
 *   node index.js --config answers.json   non-interactive
 *   node index.js --dry-run            print the plan, deploy nothing
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const readline = require('readline/promises');

const GOV_CLOUD = 'AzureUSGovernment';
const DEFAULT_MODELS = [
  { name: 'gpt-4.1', version: '2025-04-14', sku: 'Standard', capacity: 50 },
  { name: 'gpt-5.1', version: '2025-11-13', sku: 'DataZoneStandard', capacity: 200 },
];

// ---- pure, testable helpers ----

/** Build the ARM parameters object for the Bicep deployment. */
function buildParams(a) {
  const p = {
    location: { value: a.location || 'usgovvirginia' },
    namePrefix: { value: a.namePrefix || 'azgov-ide' },
    deployments: { value: a.models && a.models.length ? a.models : DEFAULT_MODELS },
    disableLocalAuth: { value: a.disableLocalAuth !== false },
    deployPrivateEndpoint: { value: !!a.deployPrivateEndpoint },
    privateEndpointSubnetId: { value: a.privateEndpointSubnetId || '' },
    callerPrincipalId: { value: a.callerPrincipalId || '' },
    callerPrincipalType: { value: a.callerPrincipalType || 'ServicePrincipal' },
  };
  if (typeof a.auditRetentionDays === 'number') p.auditRetentionDays = { value: a.auditRetentionDays };
  return { $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#', contentVersion: '1.0.0.0', parameters: p };
}

/** Build the locked VS Code settings from the deployment outputs. */
function buildSettings(a, out) {
  const s = {
    'azgovIde.endpoint': String(out.openAiEndpoint || '').replace(/\/+$/, ''),
    'azgovIde.authMode': a.authMode || 'managed',
    'azgovIde.store': false,
    'azgovIde.approveWrites': true,
    'azgovIde.auditEnabled': true,
    'azgovIde.auditIngestionEndpoint': out.auditIngestionEndpoint || '',
    'azgovIde.auditDcrImmutableId': out.auditDcrImmutableId || '',
    'azgovIde.auditStreamName': out.auditStreamName || 'Custom-AzgovIdeAudit_CL',
    'azgovIde.allowedModels': (a.models && a.models.length ? a.models : DEFAULT_MODELS).map((m) => m.name),
  };
  if (Array.isArray(a.commandAllowlist) && a.commandAllowlist.length) s['azgovIde.commandAllowlist'] = a.commandAllowlist;
  if (a.blockNetworkCommands) s['azgovIde.blockNetworkCommands'] = true;
  if (a.tenantId) s['azgovIde.tenantId'] = a.tenantId;
  return s;
}

/** Merge new keys into an existing settings.json body (parsed object). */
function mergeSettings(existing, next) {
  return { ...(existing && typeof existing === 'object' ? existing : {}), ...next };
}

/** Parse deployment outputs (az returns { key: { value } }). */
function readOutputs(deployResult) {
  const o = (deployResult && deployResult.properties && deployResult.properties.outputs) || {};
  const flat = {};
  for (const k of Object.keys(o)) flat[k] = o[k].value;
  return flat;
}

// ---- az plumbing ----

function az(args, sub) {
  const full = sub ? [...args, '--subscription', sub, '-o', 'json'] : [...args, '-o', 'json'];
  const out = execFileSync('az', full, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return out.trim() ? JSON.parse(out) : undefined;
}

function azQuiet(args, sub) {
  const full = sub ? [...args, '--subscription', sub] : args;
  execFileSync('az', full, { stdio: 'ignore' });
}

// ---- interactive prompts ----

async function ask(rl, q, def) {
  const suffix = def !== undefined && def !== '' ? ` [${def}]` : '';
  const ans = (await rl.question(`${q}${suffix}: `)).trim();
  return ans === '' ? def : ans;
}
async function askYesNo(rl, q, def) {
  const d = def ? 'Y/n' : 'y/N';
  const ans = (await rl.question(`${q} [${d}]: `)).trim().toLowerCase();
  if (ans === '') return def;
  return ans.startsWith('y');
}

async function gather() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('\nAzureGov IDE Coding Assistant - guided install (Azure US Government)\n');
    const a = {};
    a.subscriptionId = await ask(rl, 'Gov subscription id');
    a.resourceGroup = await ask(rl, 'Resource group (created if missing)', 'rg-azgov-ide');
    a.location = await ask(rl, 'Region', 'usgovvirginia');
    a.namePrefix = await ask(rl, 'Name prefix', 'azgov-ide');
    a.deployPrivateEndpoint = await askYesNo(rl, 'Deploy a private endpoint (no public access)?', false);
    if (a.deployPrivateEndpoint) a.privateEndpointSubnetId = await ask(rl, 'Existing subnet resource id for the private endpoint');
    a.disableLocalAuth = await askYesNo(rl, 'Disable local api-key auth (recommended)?', true);
    a.callerPrincipalId = await ask(rl, 'Object id of the calling identity (VM managed identity) for role assignments (blank to skip)', '');
    if (a.callerPrincipalId) a.callerPrincipalType = await ask(rl, 'Principal type (ServicePrincipal/User/Group)', 'ServicePrincipal');
    a.blockNetworkCommands = await askYesNo(rl, 'Block ad-hoc network/egress terminal commands?', false);
    a.settingsPath = await ask(rl, 'Where to write .vscode/settings.json (workspace root)', process.cwd());
    return a;
  } finally {
    rl.close();
  }
}

// ---- main ----

function parseArgs(argv) {
  const o = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') o.dryRun = true;
    else if (argv[i] === '--config') o.config = argv[++i];
    else if (argv[i] === '--template') o.template = argv[++i];
  }
  return o;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const template = opts.template || path.join(__dirname, '..', '..', 'infra', 'main.bicep');
  const answers = opts.config ? JSON.parse(fs.readFileSync(opts.config, 'utf8')) : await gather();

  if (!answers.subscriptionId) throw new Error('subscriptionId is required.');
  const sub = answers.subscriptionId;

  const params = buildParams(answers);
  const paramsFile = path.join(os.tmpdir(), `azgov-ide-params-${Date.now()}.json`);
  fs.writeFileSync(paramsFile, JSON.stringify(params, null, 2), 'utf8');

  console.log('\nPlan:');
  console.log(`  cloud             ${GOV_CLOUD}`);
  console.log(`  subscription      ${sub}`);
  console.log(`  resource group    ${answers.resourceGroup} (${answers.location || 'usgovvirginia'})`);
  console.log(`  private endpoint  ${!!answers.deployPrivateEndpoint}`);
  console.log(`  disable local auth ${answers.disableLocalAuth !== false}`);
  console.log(`  role assignments  ${answers.callerPrincipalId ? 'yes' : 'skipped'}`);
  console.log(`  template          ${template}`);
  console.log(`  params            ${paramsFile}`);

  if (opts.dryRun) {
    console.log('\n--dry-run: not deploying. Settings preview:');
    console.log(JSON.stringify(buildSettings(answers, { openAiEndpoint: 'https://aoai-<prefix>.openai.azure.us', auditIngestionEndpoint: '(from deploy)', auditDcrImmutableId: '(from deploy)', auditStreamName: 'Custom-AzgovIdeAudit_CL' }), null, 2));
    return;
  }

  // Pin cloud + subscription defensively (the CLI is known to drift).
  azQuiet(['cloud', 'set', '--name', GOV_CLOUD]);
  azQuiet(['account', 'set', '--subscription', sub]);
  console.log('\nCreating resource group...');
  azQuiet(['group', 'create', '-n', answers.resourceGroup, '-l', answers.location || 'usgovvirginia'], sub);

  console.log('Deploying infrastructure (this can take several minutes)...');
  const result = az(['deployment', 'group', 'create', '-g', answers.resourceGroup, '--template-file', template, '--parameters', `@${paramsFile}`], sub);
  const outputs = readOutputs(result);
  console.log('Deployment complete.');
  console.log(`  endpoint     ${outputs.openAiEndpoint}`);
  console.log(`  audit ingest ${outputs.auditIngestionEndpoint}`);
  console.log(`  audit dcr    ${outputs.auditDcrImmutableId}`);

  // Write locked settings.
  const settings = buildSettings(answers, outputs);
  const dir = path.join(answers.settingsPath || process.cwd(), '.vscode');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'settings.json');
  let existing = {};
  if (fs.existsSync(file)) {
    try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* keep {} */ }
    fs.copyFileSync(file, `${file}.bak`);
  }
  fs.writeFileSync(file, JSON.stringify(mergeSettings(existing, settings), null, 2), 'utf8');
  console.log(`\nWrote ${file}`);
  console.log('\nNext: install the extension VSIX in VS Code and open this folder.');
  console.log('For org-wide enforcement, push these settings as policy (GPO/Intune) instead of settings.json.');
}

module.exports = { buildParams, buildSettings, mergeSettings, readOutputs, parseArgs, DEFAULT_MODELS };

if (require.main === module) {
  main().catch((e) => {
    console.error(`\nERROR: ${e.message}`);
    process.exit(1);
  });
}
