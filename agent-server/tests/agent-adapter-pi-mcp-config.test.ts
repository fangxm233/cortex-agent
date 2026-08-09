// input:  portable MCP configs and temp roots
// output: PI config privacy and reload coverage
// pos:    Tests the PI MCP config writer and parser
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  loadPiPluginMcpConfig,
  piPluginMcpConfigJson,
  readPiPluginMcpConfig,
  writePiPluginMcpConfig,
  type PiPluginMcpConfig,
} from '../src/agent-adapter/pi/mcp-config.js';
import type { McpServerConfig } from '../src/agent-adapter/types.js';

const HTTP_SERVER: McpServerConfig = {
  name: 'z-http', type: 'streamable-http', url: 'https://private.example.com/mcp',
  headers: { Authorization: 'Bearer secret-http' },
};
const STDIO_SERVER: McpServerConfig = {
  name: 'a-stdio', type: 'stdio', command: '/opt/private-server', args: ['--token', 'secret-arg'],
  env: { API_KEY: 'secret-env' }, cwd: '/opt/private-cwd',
};
const SSE_SERVER: McpServerConfig = {
  name: 'm-sse', type: 'sse', url: 'https://private.example.com/events',
  headers: { 'X-Secret': 'secret-sse' },
};
const PORTABLE_STDIO: McpServerConfig = { ...STDIO_SERVER, name: 'portable-stdio' };
const PORTABLE_SSE: McpServerConfig = { ...SSE_SERVER, name: 'portable-sse' };

function withTempRuntime(prefix: string, run: (runtimeDir: string) => void): void {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    run(runtimeDir);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
}

function writePortableConfigs(runtimeDir: string): [PiPluginMcpConfig, PiPluginMcpConfig] {
  const written = writePiPluginMcpConfig([PORTABLE_STDIO, PORTABLE_SSE], { runtimeDir });
  const again = writePiPluginMcpConfig([PORTABLE_SSE, PORTABLE_STDIO], { runtimeDir });
  return [written, again];
}

function assertConfigIdentity(written: PiPluginMcpConfig, again: PiPluginMcpConfig): void {
  assert.equal(again.identity, written.identity);
  assert.equal(again.path, written.path);
  assert.deepEqual(readPiPluginMcpConfig(written.path), [PORTABLE_SSE, PORTABLE_STDIO]);
}

function assertPrivateConfig(runtimeDir: string, written: PiPluginMcpConfig): void {
  const parentMode = fs.statSync(path.join(runtimeDir, 'pi-mcp')).mode & 0o777;
  const fileMode = fs.statSync(written.path).mode & 0o777;
  assert.equal(parentMode, 0o700);
  assert.equal(fileMode, 0o600);
  assert.equal(
    fs.readFileSync(written.path, 'utf8'),
    piPluginMcpConfigJson([PORTABLE_SSE, PORTABLE_STDIO]),
  );
  assert.deepEqual(fs.readdirSync(path.join(runtimeDir, 'pi-mcp')).filter(name => name.includes('.tmp.')), []);
}

function verifyPortableConfigWrite(runtimeDir: string): void {
  const [written, again] = writePortableConfigs(runtimeDir);
  assertConfigIdentity(written, again);
  assertPrivateConfig(runtimeDir, written);
}

test('piPluginMcpConfigJson preserves typed stdio, streamable-http, and sse runtimes deterministically', () => {
  const text = piPluginMcpConfigJson([HTTP_SERVER, STDIO_SERVER, SSE_SERVER]);
  assert.deepEqual(JSON.parse(text), { mcpServers: [STDIO_SERVER, SSE_SERVER, HTTP_SERVER] });
});

test('writePiPluginMcpConfig is deterministic, atomic, private on disk, and readable as typed config', () => {
  withTempRuntime('cortex-pi-plugin-mcp-', verifyPortableConfigWrite);
});

test('writePiPluginMcpConfig rejects symlinked runtime ancestry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-pi-mcp-link-'));
  const physical = path.join(root, 'physical');
  const alias = path.join(root, 'alias');
  fs.mkdirSync(physical);
  fs.symlinkSync(physical, alias, 'dir');
  try {
    assert.throws(() => writePiPluginMcpConfig([], {
      runtimeDir: path.join(alias, 'runtime'),
    }), /symlink|physical/i);
    assert.equal(fs.existsSync(path.join(physical, 'runtime')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readPiPluginMcpConfig requires a private non-symlink file whose content hash matches the filename', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-pi-plugin-mcp-'));
  try {
    const written = writePiPluginMcpConfig([
      {
        name: 'portable-http',
        type: 'streamable-http',
        url: 'https://private.example.com/mcp',
        headers: { Authorization: 'Bearer secret-http' },
      },
    ], { runtimeDir });
    fs.chmodSync(written.path, 0o644);
    assert.throws(() => readPiPluginMcpConfig(written.path), /not private/i);
    fs.chmodSync(written.path, 0o600);
    fs.writeFileSync(written.path, '{"mcpServers":[]}' + '\n');
    assert.throws(() => readPiPluginMcpConfig(written.path), /identity mismatch/i);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

function writeHashedConfig(runtimeDir: string, text: string): string {
  const hash = createHash('sha256').update(text, 'utf8').digest('hex');
  const filePath = path.join(runtimeDir, 'pi-mcp', `${hash}.json`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, text, { mode: 0o600 });
  return filePath;
}

function verifyMalformedConfigRecovery(runtimeDir: string): void {
  const written = writePiPluginMcpConfig([{ ...HTTP_SERVER, name: 'portable-http' }], { runtimeDir });
  const malformedText = `${JSON.stringify({ mcpServers: [], extra: true }, null, 2)}\n`;
  const malformedPath = writeHashedConfig(runtimeDir, malformedText);
  assert.equal(loadPiPluginMcpConfig(malformedPath).servers.length, 0);
  assert.equal(loadPiPluginMcpConfig(malformedPath).issues.length, 1);

  const envelope = JSON.parse(fs.readFileSync(written.path, 'utf8')) as { mcpServers: unknown[] };
  envelope.mcpServers.push({ type: 'stdio', command: 42, args: [], env: {}, cwd: '/bad' });
  const tampered = `${JSON.stringify(envelope, null, 2)}\n`;
  const loaded = loadPiPluginMcpConfig(writeHashedConfig(runtimeDir, tampered));
  assert.deepEqual(loaded.servers.map(server => server.name), ['portable-http']);
  assert.equal(loaded.issues.length, 1);
}

test('loadPiPluginMcpConfig rejects malformed envelopes but skips malformed entries inside a valid envelope', () => {
  withTempRuntime('cortex-pi-plugin-mcp-', verifyMalformedConfigRecovery);
});

function duplicateConfigText(): string {
  return `${JSON.stringify({
    mcpServers: [
      {
        name: 'portable-dup', type: 'streamable-http',
        url: 'https://one.example.com/mcp', headers: {},
      },
      {
        name: 'portable-dup', type: 'sse',
        url: 'https://two.example.com/events', headers: {},
      },
      {
        name: 'portable-unique', type: 'sse',
        url: 'https://unique.example.com/events', headers: {},
      },
    ],
  }, null, 2)}\n`;
}

function verifyDuplicateConfigRecovery(runtimeDir: string): void {
  const filePath = writeHashedConfig(runtimeDir, duplicateConfigText());
  const loaded = loadPiPluginMcpConfig(filePath);
  assert.deepEqual(loaded.servers.map(server => server.name), ['portable-dup', 'portable-unique']);
  assert.equal(loaded.issues.length, 1);
  assert.match(loaded.issues[0].path, /#mcpServers\[1\]\.name$/);
  assert.match(loaded.issues[0].message, /Duplicate PI plugin MCP server name: portable-dup/);
  assert.throws(() => readPiPluginMcpConfig(filePath), /Duplicate PI plugin MCP server name: portable-dup/);
}

test('loadPiPluginMcpConfig reports and skips duplicate server names per entry', () => {
  withTempRuntime('cortex-pi-plugin-mcp-', verifyDuplicateConfigRecovery);
});

test('writePiPluginMcpConfig fails closed when a pre-existing file is tampered', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-pi-plugin-mcp-'));
  try {
    const written = writePiPluginMcpConfig([
      {
        name: 'portable-http',
        type: 'streamable-http',
        url: 'https://private.example.com/mcp',
        headers: { Authorization: 'Bearer secret-http' },
      },
    ], { runtimeDir });
    fs.writeFileSync(written.path, '{"mcpServers":[]}' + '\n');

    assert.throws(
      () => writePiPluginMcpConfig([
        {
          name: 'portable-http',
          type: 'streamable-http',
          url: 'https://private.example.com/mcp',
          headers: { Authorization: 'Bearer secret-http' },
        },
      ], { runtimeDir }),
      /mismatch/i,
    );
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});
