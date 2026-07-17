import * as vscode from 'vscode';

export interface ExtConfig {
  endpoint: string;
  model: string;
  authMode: 'entra' | 'key' | 'managed';
  tenantId: string;
  store: boolean;
  approveWrites: boolean;
}

export function readConfig(): ExtConfig {
  const c = vscode.workspace.getConfiguration('azgovIde');
  return {
    endpoint: c.get<string>('endpoint', 'https://aoai-azgov-ide.openai.azure.us'),
    model: c.get<string>('model', 'gpt-4.1'),
    authMode: c.get<'entra' | 'key' | 'managed'>('authMode', 'entra'),
    tenantId: c.get<string>('tenantId', ''),
    store: c.get<boolean>('store', false),
    approveWrites: c.get<boolean>('approveWrites', true),
  };
}
