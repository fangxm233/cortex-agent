// input:  pinned Node launcher, child fixture, temporary directories
// output: module-load path pinning and forbidden-env regression proof
// pos:    Fresh-process environment boundary tests
// >>> If I am updated, update my header and folder CORTEX.md <<<

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, it } from 'vitest';
import {
  PINNED_ENV_KEYS,
  PINNED_RUNTIME_PATH,
  preparePinnedNodeLaunch,
  spawnPinnedNode,
} from '../../../src/domain/agent-run/pinned-node-process.js';

const CHILD = fileURLToPath(new URL('./pinned-paths-child.ts', import.meta.url));
const TSX = createRequire(import.meta.url).resolve('tsx');
let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pinned-node-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function collect(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    stream.on('data', chunk => { output += chunk.toString(); });
    stream.on('end', () => resolve(output));
    stream.on('error', reject);
  });
}

async function runChild(parentEnv: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const child = spawnPinnedNode({
    trialRoot: root,
    workspaceCwd: workspace,
    entry: CHILD,
    nodeArgs: ['--import', TSX],
    parentEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = collect(child.stdout!);
  const stderr = collect(child.stderr!);
  const exitCode = await new Promise<number | null>(resolve => child.once('close', resolve));
  assert.equal(exitCode, 0, await stderr);
  return JSON.parse((await stdout).trim());
}

it('pins core paths at module load plus homedir and tmpdir under one trial root', async () => {
  const result = await runChild({ PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' });
  const cortexHome = path.join(root, 'cortex-home');

  assert.deepEqual(result, {
    dataDir: cortexHome,
    configDir: path.join(cortexHome, 'config'),
    storeDir: path.join(cortexHome, 'data'),
    projectsDir: path.join(root, 'projects'),
    workspaceDir: path.join(cortexHome, 'tmp'),
    homeDir: path.join(root, 'home'),
    tempDir: path.join(root, 'tmp'),
    envKeys: [
      ...PINNED_ENV_KEYS,
      'LANG',
      'PATH',
    ].sort(),
    forbiddenValue: null,
    nodeSentinel: null,
    nodeOptions: null,
    nodePath: null,
    pathValue: PINNED_RUNTIME_PATH,
  });
});

it('drops a forbidden host variable while preserving allowlisted Node runtime variables', async () => {
  const result = await runChild({
    PATH: `${path.join(os.homedir(), '.cortex/bin')}${path.delimiter}/usr/bin`,
    SLACK_BOT_TOKEN: 'must-not-cross',
    HTTP_PROXY: 'http://host-proxy.invalid',
    SSH_AUTH_SOCK: '/host/ssh-agent.sock',
    CORTEX_HOST_PATH: '/host/.cortex',
    NODE_ENV: 'test',
    NODE_OPTIONS: '--require /host/preload.cjs',
    NODE_PATH: '/host/node_modules',
    TERM: 'xterm-256color',
  });

  assert.equal(result.forbiddenValue, null);
  assert.equal(result.nodeSentinel, 'test');
  assert.equal(result.nodeOptions, null);
  assert.equal(result.nodePath, null);
  assert.equal(result.pathValue, PINNED_RUNTIME_PATH);
  assert.deepEqual(result.envKeys, [...PINNED_ENV_KEYS, 'NODE_ENV', 'PATH', 'TERM'].sort());
});

it('accepts a caller-named passthrough confined to the trial root', () => {
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const safeValue = path.join(root, 'input.json');
  const launch = preparePinnedNodeLaunch({
    trialRoot: root,
    workspaceCwd: workspace,
    entry: CHILD,
    parentEnv: { CUSTOM_INPUT: safeValue },
    passthroughEnv: ['CUSTOM_INPUT'],
  });

  assert.equal(launch.env.CUSTOM_INPUT, safeValue);
});

it('rejects absolute and cwd-relative passthrough references to host roots', () => {
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const base = { trialRoot: root, workspaceCwd: workspace, entry: CHILD };
  assert.throws(() => preparePinnedNodeLaunch({
    ...base,
    parentEnv: { CUSTOM_INPUT: path.join(os.homedir(), '.ssh/config') },
    passthroughEnv: ['CUSTOM_INPUT'],
  }), /references a forbidden host root/);

  const hostCortex = path.join(path.dirname(root), `${path.basename(root)}-host-cortex`);
  assert.throws(() => preparePinnedNodeLaunch({
    ...base,
    parentEnv: {
      CORTEX_HOME: hostCortex,
      CUSTOM_INPUT: path.relative(workspace, path.join(hostCortex, 'config/settings.json')),
    },
    passthroughEnv: ['CUSTOM_INPUT'],
  }), /references a forbidden host root/);
  assert.throws(() => preparePinnedNodeLaunch({
    ...base,
    parentEnv: {
      CORTEX_HOME: hostCortex,
      CUSTOM_INPUT: `/usr/lib${path.delimiter}${hostCortex}/data`,
    },
    passthroughEnv: ['CUSTOM_INPUT'],
  }), /references a forbidden host root/);
});

it('rejects file URLs and trial symlinks that reference host roots', () => {
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const hostCortex = path.join(os.homedir(), '.cortex');
  const base = { trialRoot: root, workspaceCwd: workspace, entry: CHILD };
  assert.throws(() => preparePinnedNodeLaunch({
    ...base,
    parentEnv: { CUSTOM_INPUT: pathToFileURL(path.join(hostCortex, 'threads.json')).href },
    passthroughEnv: ['CUSTOM_INPUT'],
  }), /references a forbidden host root/);

  const alias = path.join(root, 'host-alias');
  fs.symlinkSync(hostCortex, alias, 'dir');
  assert.throws(() => preparePinnedNodeLaunch({
    ...base,
    parentEnv: { CUSTOM_INPUT: path.join(alias, 'threads.json') },
    passthroughEnv: ['CUSTOM_INPUT'],
  }), /references a forbidden host root/);
});

it('disables Node global search paths before loading the entry', () => {
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const launch = preparePinnedNodeLaunch({
    trialRoot: root,
    workspaceCwd: workspace,
    entry: CHILD,
    parentEnv: { PATH: process.env.PATH },
  });

  assert.equal(launch.args[0], '--no-global-search-paths');
});

it('refuses a non-empty projects scratch directory', () => {
  const projects = path.join(root, 'projects');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(projects);
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(projects, 'host-project'), 'sentinel');

  assert.throws(() => preparePinnedNodeLaunch({
    trialRoot: root,
    workspaceCwd: workspace,
    entry: CHILD,
    parentEnv: { PATH: process.env.PATH },
  }), /CORTEX_PROJECTS_DIR must be empty/);
});
