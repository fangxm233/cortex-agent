// input:  one-shot launcher auth file and sealed production environment
// output: authenticated app import with the credential file already unlinked
// pos:    Production benchmark bootstrap that keeps bearer tokens out of initial process env
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import fs from 'node:fs';
import path from 'node:path';

import { isMainModule } from '@core/utils.js';

interface ProductionServerAuth {
  clientToken: string;
  webhookToken: string;
}

function parseProductionServerAuth(text: string): ProductionServerAuth {
  const value = JSON.parse(text) as Record<string, unknown>;
  const keys = value && typeof value === 'object' ? Object.keys(value).sort() : [];
  const valid = (
    keys.length === 2 && keys[0] === 'clientToken' && keys[1] === 'webhookToken'
    && typeof value.clientToken === 'string' && /^[0-9a-f]{64}$/.test(value.clientToken)
    && typeof value.webhookToken === 'string' && /^[0-9a-f]{64}$/.test(value.webhookToken)
    && value.clientToken !== value.webhookToken
  );
  if (!valid) throw new Error('production server auth file is invalid');
  return value as unknown as ProductionServerAuth;
}

export function consumeProductionServerAuth(
  authPath: string, env: NodeJS.ProcessEnv = process.env,
): void {
  if (!path.isAbsolute(authPath)) throw new Error('production server auth path must be absolute');
  let text: string;
  try {
    text = fs.readFileSync(authPath, 'utf8');
  } finally {
    fs.rmSync(authPath, { force: true });
  }
  const auth = parseProductionServerAuth(text);
  env.CORTEX_CLIENT_TOKEN = auth.clientToken;
  env.CORTEX_WEBHOOK_TOKEN = auth.webhookToken;
  delete env.CORTEX_PRODUCTION_AUTH_FILE;
}

async function main(): Promise<void> {
  const authPath = process.env.CORTEX_PRODUCTION_AUTH_FILE;
  if (!authPath) throw new Error('CORTEX_PRODUCTION_AUTH_FILE is required');
  consumeProductionServerAuth(authPath);
  await import('./app.js');
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
    process.exitCode = 1;
  });
}
