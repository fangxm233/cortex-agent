// input:  Injected doctor environment and filesystem probes
// output: Diagnostic reports and safe-fix assertions
// pos:    Doctor engine regression tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  runDiagnostics,
  applySafeFixes,
  type DoctorDeps,
  type FixActuators,
  type DoctorReport,
} from '../../../src/domain/system/doctor.js';

// ─── helpers ──────────────────────────────────────────────────────

/** A trivial KEY=value parser sufficient for tests. */
function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** All-green dependency set. Override fields per test. */
function baseDeps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  const present = new Set([
    '/d', '/c', '/s', // data directories
    '/c/.env',
    '/s/mode.json',
    '/c/profiles.json',
    '/c/mcp-config.json',
    '/h/.aistatus/gateway.yaml',
  ]);
  const texts: Record<string, string> = {
    '/c/.env': '',
    '/s/mode.json': '{"backend":"claude","mode":"api"}',
    '/c/profiles.json': '{"profiles":{"default":{"model":"x"}},"defaultProfile":"default"}',
    '/c/mcp-config.json': '{}',
    '/h/.aistatus/gateway.yaml': 'endpoints: {}',
  };
  return {
    env: {
      CORTEX_CLIENT_TOKEN: 'ctok',
      CORTEX_WEBHOOK_TOKEN: 'wtok',
      ANTHROPIC_API_KEY: 'sk-real',
      CORTEX_PLATFORM: 'slack',
      SLACK_BOT_TOKEN: 'xoxb-1',
      SLACK_SIGNING_SECRET: 'sign',
      SLACK_APP_TOKEN: 'xapp-1',
    },
    paths: { DATA_DIR: '/d', CONFIG_DIR: '/c', STORE_DIR: '/s' },
    homeDir: '/h',
    nodeVersion: 'v20.11.0',
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

/** Flatten all checks into a lookup by id. */
function byId(report: DoctorReport): Record<string, { status: string; fixable?: boolean; detail: string; hint?: string }> {
  const out: Record<string, any> = {};
  for (const s of report.sections) for (const c of s.checks) out[c.id] = c;
  return out;
}

// ─── runDiagnostics: happy path ───────────────────────────────────

describe('runDiagnostics — all green', () => {
  it('reports ok=true with zero failures and four sections', async () => {
    const report = await runDiagnostics(baseDeps());
    assert.equal(report.ok, true);
    assert.equal(report.counts.fail, 0);
    assert.equal(report.sections.length, 4);
  });

  it('passes the core credential checks', async () => {
    const checks = byId(await runDiagnostics(baseDeps()));
    assert.equal(checks['auth-tokens'].status, 'pass');
    assert.equal(checks['slack-creds'].status, 'pass');
    assert.equal(checks['anthropic-key'].status, 'pass');
  });

  it('checks the PI binary for a PI mode file', async () => {
    const deps = baseDeps();
    const readText = deps.readText;
    const checked: string[] = [];
    deps.readText = (p) => p === '/s/mode.json' ? '{"backend":"pi"}' : readText(p);
    deps.commandExists = (bin) => { checked.push(bin); return true; };

    await runDiagnostics(deps);

    assert.ok(checked.includes('pi'));
  });
});

// ─── Backend / login failures ─────────────────────────────────────

describe('runDiagnostics — auth tokens', () => {
  it('fails and marks fixable when a token is missing', async () => {
    const deps = baseDeps({ env: { CORTEX_CLIENT_TOKEN: '', CORTEX_WEBHOOK_TOKEN: 'wtok', CORTEX_PLATFORM: 'slack', SLACK_BOT_TOKEN: 'xoxb-1', SLACK_SIGNING_SECRET: 's', SLACK_APP_TOKEN: 'xapp-1' } });
    const checks = byId(await runDiagnostics(deps));
    assert.equal(checks['auth-tokens'].status, 'fail');
    assert.equal(checks['auth-tokens'].fixable, true);
  });

  it('warns (not fail) when ANTHROPIC_API_KEY is absent', async () => {
    const env = { ...baseDeps().env };
    delete env.ANTHROPIC_API_KEY;
    const checks = byId(await runDiagnostics(baseDeps({ env })));
    assert.equal(checks['anthropic-key'].status, 'warn');
  });

  it('treats the gateway-managed placeholder key as pass', async () => {
    const checks = byId(await runDiagnostics(baseDeps({
      env: { ...baseDeps().env, ANTHROPIC_API_KEY: 'cortex-gateway-managed' },
    })));
    assert.equal(checks['anthropic-key'].status, 'pass');
  });

  it('fails .env check and is fixable when .env is missing', async () => {
    const deps = baseDeps({ fileExists: (p: string) => p !== '/c/.env' });
    const checks = byId(await runDiagnostics(deps));
    assert.equal(checks['env-file'].status, 'fail');
  });
});

// ─── Messaging platform ───────────────────────────────────────────

describe('runDiagnostics — platform creds', () => {
  it('fails slack when bot token lacks xoxb- prefix', async () => {
    const checks = byId(await runDiagnostics(baseDeps({
      env: { ...baseDeps().env, SLACK_BOT_TOKEN: 'bad-token' },
    })));
    assert.equal(checks['slack-creds'].status, 'fail');
    assert.match(checks['slack-creds'].detail, /xoxb-/);
  });

  it('checks feishu creds when CORTEX_PLATFORM=feishu', async () => {
    const checks = byId(await runDiagnostics(baseDeps({
      env: { CORTEX_CLIENT_TOKEN: 'a', CORTEX_WEBHOOK_TOKEN: 'b', CORTEX_PLATFORM: 'feishu' },
    })));
    assert.equal(checks['feishu-creds'].status, 'fail');
    assert.equal(checks['slack-creds'], undefined);
  });
});

// ─── Gateway ──────────────────────────────────────────────────────

describe('runDiagnostics — gateway', () => {
  it('fails health when gateway is in use (placeholder key) but down', async () => {
    const checks = byId(await runDiagnostics(baseDeps({
      env: { ...baseDeps().env, ANTHROPIC_API_KEY: 'cortex-gateway-managed' },
      probeGateway: async () => false,
    })));
    assert.equal(checks['gateway-health'].status, 'fail');
  });

  it('skips health when gateway is idle (real key, no gateway needed) and down', async () => {
    const checks = byId(await runDiagnostics(baseDeps({
      fileExists: (p: string) => p !== '/h/.aistatus/gateway.yaml',
      probeGateway: async () => false,
    })));
    assert.equal(checks['gateway-health'].status, 'skip');
  });

  it('passes health when gateway responds', async () => {
    const checks = byId(await runDiagnostics(baseDeps({ probeGateway: async () => true })));
    assert.equal(checks['gateway-health'].status, 'pass');
  });
});

// ─── Runtime ──────────────────────────────────────────────────────

describe('runDiagnostics — runtime', () => {
  it('warns on an old node major', async () => {
    const checks = byId(await runDiagnostics(baseDeps({ nodeVersion: 'v18.0.0' })));
    assert.equal(checks['node-version'].status, 'warn');
  });

  it('fails when git is not on PATH', async () => {
    const checks = byId(await runDiagnostics(baseDeps({ commandExists: (b: string) => b !== 'git' })));
    assert.equal(checks['git'].status, 'fail');
  });
});

// ─── applySafeFixes ───────────────────────────────────────────────

describe('applySafeFixes', () => {
  it('actuates only fixable failures (tokens, dirs, mcp) idempotently', async () => {
    const deps = baseDeps({
      env: { CORTEX_CLIENT_TOKEN: '', CORTEX_WEBHOOK_TOKEN: '', CORTEX_PLATFORM: 'slack', SLACK_BOT_TOKEN: 'xoxb-1', SLACK_SIGNING_SECRET: 's', SLACK_APP_TOKEN: 'xapp-1' },
      fileExists: (p: string) => p !== '/c/mcp-config.json', // mcp missing → fixable warn
    });
    const calls: string[] = [];
    const fix: FixActuators = {
      mkdirp: (p: string) => calls.push(`mkdir:${p}`),
      ensureEnvFile: (p: string) => calls.push(`envfile:${p}`),
      ensureAuthTokens: (p: string) => { calls.push(`tokens:${p}`); return ['CORTEX_CLIENT_TOKEN', 'CORTEX_WEBHOOK_TOKEN']; },
      regenerateMcpConfig: () => calls.push('mcp'),
    };
    const report = await runDiagnostics(deps);
    const outcomes = await applySafeFixes(report, deps, fix);
    const fixedIds = outcomes.filter(o => o.applied).map(o => o.id);
    assert.ok(fixedIds.includes('auth-tokens'), 'auth-tokens fixed');
    assert.ok(fixedIds.includes('mcp-config'), 'mcp-config fixed');
    assert.ok(calls.includes('mcp'));
    assert.ok(calls.some(c => c.startsWith('tokens:')));
  });

  it('does not actuate non-fixable failures (slack creds)', async () => {
    const deps = baseDeps({ env: { ...baseDeps().env, SLACK_BOT_TOKEN: 'bad' } });
    const calls: string[] = [];
    const fix: FixActuators = {
      mkdirp: () => calls.push('mkdir'),
      ensureEnvFile: () => calls.push('envfile'),
      ensureAuthTokens: () => { calls.push('tokens'); return []; },
      regenerateMcpConfig: () => calls.push('mcp'),
    };
    const report = await runDiagnostics(deps);
    const outcomes = await applySafeFixes(report, deps, fix);
    assert.equal(outcomes.find(o => o.id === 'slack-creds'), undefined);
  });
});
