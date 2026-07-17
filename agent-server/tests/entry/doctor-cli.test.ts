// input:  node:test, src/entry/doctor-cli
// output: Test results for cmdDoctor (help / text / json / exit codes / --fix)
// pos:    Verifies the `cortex doctor` CLI wrapper: flag parsing, output formatting,
//         exit-code mapping, and --fix re-run behavior. Uses injected diag/fix deps.
// >>> If I am updated, update the parent folder's CORTEX.md <<<

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { cmdDoctor, getDoctorHelp } from '../../src/entry/doctor-cli.js';
import type { DoctorDeps, FixActuators } from '../../src/domain/system/doctor.js';

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function greenDeps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  const present = new Set(['/d', '/c', '/s', '/c/.env', '/s/mode.json', '/c/profiles.json', '/c/mcp-config.json', '/h/.aistatus/gateway.yaml']);
  const texts: Record<string, string> = {
    '/c/.env': '',
    '/s/mode.json': '{"backend":"claude"}',
    '/c/profiles.json': '{"profiles":{"default":{"model":"x"}},"defaultProfile":"default"}',
    '/c/mcp-config.json': '{}',
    '/h/.aistatus/gateway.yaml': 'x: 1',
  };
  return {
    env: {
      CORTEX_CLIENT_TOKEN: 'a', CORTEX_WEBHOOK_TOKEN: 'b', ANTHROPIC_API_KEY: 'sk',
      CORTEX_PLATFORM: 'slack', SLACK_BOT_TOKEN: 'xoxb-1', SLACK_SIGNING_SECRET: 's', SLACK_APP_TOKEN: 'xapp-1',
    },
    paths: { DATA_DIR: '/d', CONFIG_DIR: '/c', STORE_DIR: '/s' },
    homeDir: '/h',
    nodeVersion: 'v20.0.0',
    requiredNodeMajor: 20,
    fileExists: (p: string) => present.has(p),
    isWritable: () => true,
    readText: (p: string) => (p in texts ? texts[p] : null),
    parseDotenv: parseEnv,
    commandExists: () => true,
    pidAlive: () => true,
    probeGateway: async () => true,
    ...over,
  };
}

const noopFix: FixActuators = {
  mkdirp: () => {},
  ensureEnvFile: () => {},
  ensureAuthTokens: () => [],
  regenerateMcpConfig: () => {},
};

describe('getDoctorHelp', () => {
  it('describes the doctor command and flags', () => {
    const help = getDoctorHelp();
    assert.match(help, /doctor/);
    assert.match(help, /--fix/);
    assert.match(help, /--json/);
  });
});

describe('cmdDoctor — help', () => {
  it('returns help on --help with exit 0', async () => {
    const r = await cmdDoctor(['--help']);
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /Usage:/);
  });
});

describe('cmdDoctor — text output + exit codes', () => {
  it('exits 0 and prints a summary when all checks pass', async () => {
    const r = await cmdDoctor([], { diag: greenDeps(), fix: noopFix });
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /Summary:/);
    assert.match(r.stdout, /\[OK\]/);
  });

  it('exits 1 when a check fails', async () => {
    const diag = greenDeps({ commandExists: (b: string) => b !== 'git' });
    const r = await cmdDoctor([], { diag, fix: noopFix });
    assert.equal(r.exitCode, 1);
    assert.match(r.stdout, /\[FAIL\]/);
  });
});

describe('cmdDoctor — json output', () => {
  it('emits parseable JSON with sections and counts', async () => {
    const r = await cmdDoctor(['--json'], { diag: greenDeps(), fix: noopFix });
    const parsed = JSON.parse(r.stdout);
    assert.ok(Array.isArray(parsed.sections));
    assert.equal(typeof parsed.counts.fail, 'number');
    assert.equal(parsed.ok, true);
  });
});

describe('cmdDoctor — --fix', () => {
  it('actuates fixes then re-runs diagnostics', async () => {
    // Missing tokens → fixable fail. After fix, the env gains tokens so the re-run passes.
    const env: Record<string, string | undefined> = {
      CORTEX_CLIENT_TOKEN: '', CORTEX_WEBHOOK_TOKEN: '', ANTHROPIC_API_KEY: 'sk',
      CORTEX_PLATFORM: 'slack', SLACK_BOT_TOKEN: 'xoxb-1', SLACK_SIGNING_SECRET: 's', SLACK_APP_TOKEN: 'xapp-1',
    };
    const diag = greenDeps({ env });
    let fixed = false;
    const fix: FixActuators = {
      mkdirp: () => {},
      ensureEnvFile: () => {},
      ensureAuthTokens: () => {
        env.CORTEX_CLIENT_TOKEN = 'gen1';
        env.CORTEX_WEBHOOK_TOKEN = 'gen2';
        fixed = true;
        return ['CORTEX_CLIENT_TOKEN', 'CORTEX_WEBHOOK_TOKEN'];
      },
      regenerateMcpConfig: () => {},
    };
    const r = await cmdDoctor(['--fix'], { diag, fix });
    assert.equal(fixed, true);
    assert.match(r.stdout, /fix/i);
    assert.equal(r.exitCode, 0);
  });
});
