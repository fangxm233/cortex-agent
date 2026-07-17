// input:  node:test, node:net, src/entry/cli
// output: Test results for parseTuiArgs, tuiPortListening, cmdTui not-listening exit
// pos:    Verifies cortex tui subcommand argument parsing, daemon detection, and
//         not-running behavior.
// >>> If I am updated, update the parent folder's CORTEX.md <<<

import { describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import net from 'node:net';

import { parseTuiArgs, tuiPortListening, cmdTui } from '../../src/entry/cli.js';

// ─── parseTuiArgs ─────────────────────────────────────────────────

describe('parseTuiArgs', () => {
  it('returns default resume=false with empty args', () => {
    const result = parseTuiArgs([]);
    assert.equal(result.resume, false);
    assert.equal(result.project, undefined);
    assert.equal(result.port, undefined);
  });

  it('parses --resume flag', () => {
    const result = parseTuiArgs(['--resume']);
    assert.equal(result.resume, true);
  });

  it('parses --project <id>', () => {
    const result = parseTuiArgs(['--project', 'proj-abc']);
    assert.equal(result.project, 'proj-abc');
  });

  it('parses --port <n>', () => {
    const result = parseTuiArgs(['--port', '4000']);
    assert.equal(result.port, 4000);
  });

  it('parses combined flags', () => {
    const result = parseTuiArgs([
      '--resume',
      '--project', 'proj-xyz',
      '--port', '3005',
    ]);
    assert.equal(result.resume, true);
    assert.equal(result.project, 'proj-xyz');
    assert.equal(result.port, 3005);
  });

  it('parses --port port number from string', () => {
    const result = parseTuiArgs(['--port', '8080']);
    assert.equal(result.port, 8080);
    assert.equal(typeof result.port, 'number');
  });
});

// ─── tuiPortListening ─────────────────────────────────────────────

describe('tuiPortListening', () => {
  it('returns false when nothing is listening (connection refused)', async () => {
    // Port 1 (tcpmux) is reserved on all platforms — nothing should be
    // listening there, so TCP connect will get ECONNREFUSED immediately.
    const result = await tuiPortListening(1);
    assert.equal(result, false);
  });

  it('returns true when a TCP server is bound on the port', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve());
      server.once('error', reject);
    });
    const port = (server.address() as net.AddressInfo).port;
    try {
      const result = await tuiPortListening(port);
      assert.equal(result, true);
    } finally {
      server.close();
    }
  });

  it('does not hang indefinitely on unreachable port', async () => {
    const start = Date.now();
    const result = await tuiPortListening(1);
    const elapsed = Date.now() - start;
    assert.equal(result, false);
    assert.ok(elapsed < 2000, `took too long: ${elapsed}ms`);
  });
});

// ─── cmdTui — daemon not running ─────────────────────────────────

describe('cmdTui', () => {
  it('writes not-running message and exits 1 when daemon not listening', async () => {
    const stderrChunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
      stderrChunks.push(chunk);
      return true;
    }) as any);

    // Mock process.exit to throw for exit code 1 (our test path), but pass
    // through for other codes so the test runner's own cleanup works.
    let exitCode: number | null = null;
    const origExit = process.exit.bind(process);
    vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      exitCode = code;
      if (code === 1) {
        throw new Error(`process.exit(${code})`);
      }
      // Passthrough for test runner's own exit (undefined / 0)
      origExit(code as any);
    }) as any);

    try {
      await cmdTui(['--port', '1']);
      assert.fail('cmdTui should have thrown (process.exit mocked)');
    } catch (e: any) {
      assert.ok(e.message.includes('process.exit(1)'), `Unexpected error: ${e.message}`);
      assert.equal(exitCode, 1);
      const stderr = stderrChunks.join('');
      assert.ok(stderr.includes('not running'), `stderr should contain "not running": ${stderr}`);
      assert.ok(stderr.includes('cortex daemon'), `stderr should mention "cortex daemon": ${stderr}`);
    }
  });
});
