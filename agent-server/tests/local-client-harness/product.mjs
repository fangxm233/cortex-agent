// Real packed CLI + real HTTP routes only. All credentials stay in private scratch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { CORTEX, EVIDENCE, HOME, SERVER } from './processes.mjs';

export const NODE = '/inputs/node/bin/node';
const CLI = `${SERVER}/dist/entry/cortex-cli.js`;
const ENV = { ...process.env, NODE_OPTIONS: '--import=/harness/observe.mjs' };
let sequence = 0;

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function until(action, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { return await action(); } catch { await delay(100); }
  }
  throw new Error('Bounded condition did not converge');
}

export function cli(args) {
  const tag = ++sequence;
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [CLI, ...args], { env: ENV, cwd: HOME, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI timeout')); }, 45000);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', () => { clearTimeout(timer); reject(new Error('CLI spawn failed')); });
    child.once('close', code => {
      clearTimeout(timer);
      fs.writeFileSync(`${EVIDENCE}/private-cli-${tag}.log`, stdout + '\n' + stderr, { mode: 0o600 });
      if (code !== 0) return reject(new Error('CLI failed (private log only)'));
      resolve(stdout);
    });
  });
}

export function bundleHash(directory) {
  const hash = createHash('sha256');
  for (const file of ['client.mjs', 'cortex-run-watcher.mjs']) hash.update(fs.readFileSync(`${directory}/${file}`));
  return hash.digest('hex');
}

function privateTokens() {
  const text = fs.readFileSync(`${CORTEX}/config/.env`, 'utf8');
  const get = name => text.match(new RegExp(`^${name}=([a-f0-9]+)$`, 'm'))?.[1];
  const tokens = { client: get('CORTEX_CLIENT_TOKEN'), webhook: get('CORTEX_WEBHOOK_TOKEN') };
  assert(tokens.client?.length >= 32 && tokens.webhook?.length >= 32);
  assert(tokens.client !== tokens.webhook);
  return tokens;
}

function configureJobs() {
  const path = `${CORTEX}/config/settings.json`;
  const previous = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : {};
  const settings = { ...previous, serverUpdateDisable: true, serverAutoUpdate: false,
    providerUsageCollectionEnabled: false, anthropicSubscriptionModes: [],
    memoryIndexRegenEnabled: false, storeArchiveEnabled: false, clientHotReloadEnabled: true };
  fs.writeFileSync(path, JSON.stringify(settings));
}

function verifyPrepared(hash, tokens) {
  const owner = JSON.parse(fs.readFileSync(`${CORTEX}/client/local-install.json`, 'utf8'));
  assert(owner && typeof owner === 'object' && !Array.isArray(owner));
  const configText = fs.readFileSync(`${CORTEX}/config/cortex-client.json`, 'utf8');
  const config = JSON.parse(configText);
  assert.equal(config.deviceName, 'test-local');
  assert(!configText.includes(tokens.client) && !configText.includes(tokens.webhook));
  assert.equal(bundleHash(`${CORTEX}/client/current`), hash);
}

export async function initialize() {
  assert(!fs.existsSync(`${CORTEX}/client`));
  const manifest = JSON.parse(fs.readFileSync(`${SERVER}/dist/client-bundle/manifest.json`, 'utf8'));
  assert.equal(bundleHash(`${SERVER}/dist/client-bundle`), manifest.hash);
  const answers = { lang: 'en', backends: ['pi'], gpuCount: 0, platforms: [], installService: false,
    gatewayUsage: { enabled: false }, localUi: { enabled: true, port: 3004 },
    localClient: { enabled: true }, machineName: 'test-local' };
  fs.writeFileSync(`${EVIDENCE}/answers.json`, JSON.stringify(answers));
  const stdout = await cli(['init', '--answers', `${EVIDENCE}/answers.json`, '--json',
    '--gateway-config-dir', `${HOME}/gateway`]);
  const events = stdout.trim().split('\n').map(line => JSON.parse(line));
  const endpoint = events.at(-1);
  const tokens = privateTokens();
  assert(endpoint.clientToken === tokens.client);
  assert.equal(endpoint.uiUrl, 'http://127.0.0.1:3004');
  verifyPrepared(manifest.hash, tokens);
  configureJobs();
  return { hash: manifest.hash, tokens };
}

export async function webhook(tokens, path, body) {
  const response = await fetch(`http://127.0.0.1:3001/webhook/${path}`, {
    method: body ? 'POST' : 'GET', headers: { 'x-cortex-token': tokens.webhook, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function remote(tokens, action, params) {
  const result = await webhook(tokens, 'remote-command', { device: 'test-local', action, params, timeout: 10000 });
  assert(result.success === true && result.data && !result.data.error);
  return result.data;
}

export function nodeIdentityCommand() {
  const script = `console.log(JSON.stringify({node:process.execPath,version:process.version,` +
    `env:Object.fromEntries(["HOME","CORTEX_HOME","PATH","CORTEX_NPM_PREFIX","npm_config_cache",` +
    `"CLAUDE_CONFIG_DIR"].map(k=>[k,process.env[k]]))}))`;
  return `node -e '${script}'`;
}

async function nodeIdentity(tokens) {
  const result = await remote(tokens, 'bash', { command: nodeIdentityCommand() });
  assert.equal(result.exitCode, 0);
  const value = JSON.parse(result.stdout);
  assert.equal(value.node, NODE);
  assert.equal(value.env.HOME, HOME);
  assert.equal(value.env.CORTEX_HOME, CORTEX);
  assert.equal(value.env.PATH, `${NODE.slice(0, -5)}:/usr/bin:/bin`);
  for (const name of ['CORTEX_NPM_PREFIX', 'npm_config_cache', 'CLAUDE_CONFIG_DIR']) {
    assert.equal(value.env[name], process.env[name]);
  }
  return value;
}

export async function tools(tokens) {
  const node = await nodeIdentity(tokens);
  const file = `${HOME}/harmless-proof.txt`;
  assert((await remote(tokens, 'write', { file_path: file, content: 'local-client-proof\n' })).success);
  const read = await remote(tokens, 'read', { file_path: file });
  assert(read.content.includes('1\tlocal-client-proof'));
  const exit = await remote(tokens, 'bash', { command: 'printf harmless-exit; exit 7' });
  assert.equal(exit.exitCode, 7);
  assert.equal(exit.stdout, 'harmless-exit');
  return { node, fileRoundtrip: true, exit7: true };
}
