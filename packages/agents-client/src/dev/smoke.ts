/**
 * End-to-end smoke test: drives the real Azure OpenAI Responses API in Azure US
 * Government through the full agent loop (store=false) against a REAL temp workspace.
 * The model must call list_dir + read_file to answer; the temp file contains unique
 * tokens (Badger / NimbusCache) so we can prove the answer was grounded in tool output.
 *
 * Run:  AZURE_OPENAI_API_KEY=<key> npm run smoke -w @azgov-ide/agents-client
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ResponsesAdapter } from '../responsesAdapter.js';
import { runAgentTurn } from '../agentLoop.js';
import type { Tool } from '../tools.js';

async function main(): Promise<void> {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT ?? 'https://aoai-azgov-ide.openai.azure.us';
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT ?? 'gpt-4.1';
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  if (!apiKey) throw new Error('Set AZURE_OPENAI_API_KEY (break-glass) to run the smoke test.');

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'azgov-smoke-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'src', 'app.ts'),
    'export function startBadgerGateway(port: number) {\n' +
      '  // Boots the Badger API gateway, mounts /login and /orders, opens a NimbusCache connection.\n' +
      '}\n',
    'utf8',
  );

  // Workspace-root confinement: reject any path that escapes the temp root.
  const safe = (p: string): string => {
    const resolved = path.resolve(root, p);
    const rel = path.relative(root, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`path '${p}' escapes workspace`);
    return resolved;
  };

  const tools: Tool[] = [
    {
      name: 'list_dir',
      description: 'List files and folders in a workspace directory. Use "." for the root.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      async run(args) {
        const entries = await fs.readdir(safe(String(args['path'] ?? '.')), { withFileTypes: true });
        return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n') || '(empty)';
      },
    },
    {
      name: 'read_file',
      description: 'Read a UTF-8 text file in the workspace.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      async run(args) {
        return fs.readFile(safe(String(args['path'])), 'utf8');
      },
    },
  ];

  const brain = new ResponsesAdapter({ endpoint, deployment, auth: { kind: 'apiKey', apiKey }, store: false });
  console.log(`Brain:     ${brain.id} (${brain.model})  store=${brain.store}`);
  console.log(`Endpoint:  ${endpoint}`);
  console.log(`Workspace: ${root}\n`);

  const result = await runAgentTurn({
    brain,
    system:
      'You are AzureGov IDE Assistant, a coding agent running entirely inside Azure US Government. ' +
      'Use the tools to inspect the workspace before answering. Be concise.',
    tools,
    userMessage: 'What does src/app.ts do? List the src directory first, then read the file. Answer in one sentence.',
    stream: true,
    onEvent: (e) => {
      if (e.type === 'tool_call') process.stdout.write(`\n  → ${e.tool}(${e.args})\n`);
      if (e.type === 'tool_result') process.stdout.write(`  ← ${(String(e.result).split('\n')[0] ?? '').slice(0, 72)}\n`);
      if (e.type === 'text_delta') process.stdout.write(e.text ?? '');
    },
  });

  console.log(`\n\nFINAL (${result.steps} step(s)): ${result.finalText}`);
  const grounded = /Badger|NimbusCache/.test(result.finalText);
  console.log(`GROUNDED on the real file: ${grounded}`);

  await fs.rm(root, { recursive: true, force: true });
  if (!grounded) {
    console.error('FAIL: answer was not grounded in tool output.');
    process.exit(1);
  }
  console.log('\nPASS: end-to-end agent loop works against Azure OpenAI Responses API in Gov (store=false).');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
