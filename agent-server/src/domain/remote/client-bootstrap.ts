// input:  SSH target and resolved client bundle
// output: managed client bundle and config on the target device
// pos:    One-time install and rescue CLI for server-owned clients
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createLogger } from '@core/log.js';
import { resolveBundle } from './client-hot-reload.js';

const log = createLogger('client-bootstrap');

// --- CLI args ---

function getArg(name: string): string | null {
  const idx = process.argv.indexOf(name);
  if (idx !== -1 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return null;
}

const sshHost = getArg('--host');
const deviceName = getArg('--device-name');
const serverHost = getArg('--server-host');
if (!serverHost) {
  log.error('--server-host is required');
  process.exit(1);
}
const serverPort = getArg('--server-port') || '3002';

if (!sshHost) {
  log.error(`Usage: node --import tsx src/client-bootstrap.ts --host user@host --device-name NAME [options]

Options:
  --host <user@host>        SSH target (required)
  --device-name <name>      Device name for cortex-client (required)
  --server-host <host>      Cortex server IP (required)
  --server-port <port>      Cortex server WS port (default: 3002)
`);
  process.exit(1);
}

if (!deviceName) {
  log.error('--device-name is required');
  process.exit(1);
}

// --- SSH helpers ---

function sshExec(command: string, timeout = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('ssh', ['-o', 'StrictHostKeyChecking=no', sshHost!, command], { timeout }, (err, stdout, stderr) => {
      if (err) reject(new Error(`SSH error: ${err.message}\n${stderr}`));
      else resolve(stdout.trim());
    });
  });
}

function scpTo(localPath: string, remotePath: string, timeout = 60000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('scp', ['-o', 'StrictHostKeyChecking=no', localPath, `${sshHost}:${remotePath}`], { timeout }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`SCP error: ${err.message}\n${stderr}`));
      else resolve();
    });
  });
}

// --- Bootstrap steps ---

async function main() {
  console.log(`\n=== Cortex Client Bootstrap ===`);
  console.log(`  Target:     ${sshHost}`);
  console.log(`  Device:     ${deviceName}`);
  console.log(`  Server:     ${serverHost}:${serverPort}`);
  console.log('');

  // Step 1: Check SSH connectivity
  console.log('[1/4] Checking SSH connectivity...');
  try {
    const hostname = await sshExec('hostname');
    console.log(`  Connected to: ${hostname}`);
  } catch (e) {
    log.error(`SSH connectivity check failed: ${(e as Error).message}`);
    process.exit(1);
  }

  // Step 2: Check Node.js >= 20
  console.log('[2/4] Checking Node.js...');
  try {
    const nodeVersion = await sshExec('node --version');
    console.log(`  Node.js: ${nodeVersion}`);
  } catch {
    log.error('Node.js not found. Please install Node.js (v20+) on the target machine first.');
    process.exit(1);
  }

  // Step 3: Ship the managed bundle to ~/.cortex/client/current/
  console.log('[3/4] Deploying client bundle...');
  const bundle = resolveBundle();
  if (!bundle) {
    log.error('No client bundle available (dev: client repo build failed; release: npm registry unreachable).');
    process.exit(1);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-client-deploy-'));
  try {
    await sshExec('mkdir -p ~/.cortex/client/current');
    for (const file of bundle.files) {
      const local = path.join(tmp, file.name);
      fs.writeFileSync(local, Buffer.from(file.data, 'base64'), { mode: 0o755 });
      await scpTo(local, `.cortex/client/current/${file.name}`);
    }
    console.log(`  Deployed bundle ${bundle.hash.slice(0, 12)} (v${bundle.version}) → ~/.cortex/client/current/`);
  } catch (e) {
    log.error(`Bundle deployment failed: ${(e as Error).message}`);
    process.exit(1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // Step 4: Write client config
  console.log('[4/4] Writing client config...');
  const config = JSON.stringify({
    serverHost,
    serverPort: parseInt(serverPort, 10),
    deviceName,
  });
  const escaped = config.replace(/'/g, "'\\''");
  try {
    await sshExec(`mkdir -p ~/.cortex/config && echo '${escaped}' > ~/.cortex/config/cortex-client.json`, 15000);
    console.log(`  Written ~/.cortex/config/cortex-client.json`);
  } catch (e) {
    log.error(`Failed to write config: ${(e as Error).message}`);
    process.exit(1);
  }

  console.log('\n=== Bootstrap complete ===');
  console.log('The agent-server will start this client from its machines.json registry.\n');
}

main().catch((e) => {
  log.error(`Bootstrap failed: ${e.message}`);
  process.exit(1);
});
