// input:  JSON input files/stdin and injected production exporter
// output: CLI parsing, structured output, and failure coverage
// pos:    Verifies the installed production evidence export command
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  runProductionEvidenceExportCli,
  type ProductionEvidenceExportCliDeps,
} from '../../src/entry/production-evidence-export-cli.js';

const COMPLETE_INPUT = {
  outputDirectory: '/tmp/evidence',
  project: 'cortex-self',
  trialId: 'trial-1',
  rootRunId: 'root-1',
  armName: 'direct',
  armCanonicalSha256: 'a'.repeat(64),
  bundleManifestHash: 'b'.repeat(64),
  mode: 'direct',
  expectedRoles: ['direct'],
  managerQa: null,
  proxyExport: {
    schema_version: 'cortex-bench-proxy-export/1',
    trial_id: 'trial-1',
    adapter_id: 'proxy-1',
    requests: { status: 'available', value: 1 },
    cached_tokens: { status: 'unavailable', reason: 'counter_unreadable' },
    input_tokens: { status: 'available', value: 1 },
    output_tokens: { status: 'available', value: 1 },
    audit_log: { status: 'unavailable', reason: 'counter_unreadable' },
    lease_echo: { status: 'unavailable', reason: 'counter_unreadable' },
    source: 'proxy_export',
  },
} as const;

function capture() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: { write: (value: string) => { stdout += value; return true; } },
      stderr: { write: (value: string) => { stderr += value; return true; } },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function deps(overrides: Partial<ProductionEvidenceExportCliDeps> = {}): ProductionEvidenceExportCliDeps {
  return {
    readInput: source => {
      assert.equal(source, '-');
      return JSON.stringify(COMPLETE_INPUT);
    },
    prepareProductionStores: () => {},
    exportEvidence: async input => ({
      directory: input.outputDirectory,
      compositePath: `${input.outputDirectory}/composite-manifest.json`,
      compositeSha256: 'c'.repeat(64),
      terminalPaths: [`${input.outputDirectory}/execution-root.terminal.json`],
    }),
    ...overrides,
  };
}

describe('production evidence export CLI', () => {
  it('reads launcher JSON from stdin and emits one structured result', async () => {
    const output = capture();
    let prepared = false;
    const code = await runProductionEvidenceExportCli(
      ['--input-file', '-'], output.io, deps({
        prepareProductionStores: () => { prepared = true; },
      }),
    );

    assert.equal(code, 0);
    assert.equal(prepared, true);
    assert.equal(output.stderr(), '');
    assert.deepEqual(JSON.parse(output.stdout()), {
      ok: true,
      directory: '/tmp/evidence',
      composite_path: '/tmp/evidence/composite-manifest.json',
      composite_sha256: 'c'.repeat(64),
      terminal_paths: ['/tmp/evidence/execution-root.terminal.json'],
    });
  });

  it('fails closed with structured JSON for malformed and incomplete input', async () => {
    for (const [text, message] of [
      ['{', 'valid JSON'],
      ['{}', 'output directory is missing'],
    ] as const) {
      const output = capture();
      const code = await runProductionEvidenceExportCli(
        ['--input-file', '-'], output.io, deps({
          readInput: () => text,
          exportEvidence: async () => { throw new Error(message); },
        }),
      );
      assert.equal(code, 1);
      assert.equal(output.stdout(), '');
      assert.match(JSON.parse(output.stderr()).error, new RegExp(message, 'i'));
    }
  });

  it('rejects unknown or missing flags', async () => {
    for (const args of [[], ['--unknown']] as const) {
      const output = capture();
      assert.equal(await runProductionEvidenceExportCli([...args], output.io, deps()), 1);
      assert.equal(JSON.parse(output.stderr()).ok, false);
    }
  });
});
