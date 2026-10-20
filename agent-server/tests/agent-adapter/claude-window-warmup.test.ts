import { describe, expect, it, vi } from 'vitest';
import type { ExecResult } from '../../src/core/exec-async.js';
import {
  WINDOW_WARMUP_ARGS, runWindowWarmup, type WindowWarmupLaunch,
} from '../../src/agent-adapter/claude/window-warmup.js';

const launch: WindowWarmupLaunch = { command: 'claude', env: { CLAUDE_CONFIG_DIR: '/cfg' }, cwd: '/tmp' };

function exec(partial: Partial<ExecResult>): ExecResult {
  return { ok: true, code: 0, signal: null, timedOut: false, stdout: '', stderr: '', ...partial };
}

function resultJson(fields: Record<string, unknown>): string {
  return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', ...fields });
}

describe('runWindowWarmup', () => {
  it('runs one tool-less print-mode request with the prompt on stdin', async () => {
    const run = vi.fn(async () => exec({ stdout: resultJson({}) }));
    await runWindowWarmup(launch, run);
    const [command, args, options] = run.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(command).toBe('claude');
    expect(args).toEqual(WINDOW_WARMUP_ARGS);
    expect(args).toEqual(expect.arrayContaining(['-p', '--no-session-persistence', '--strict-mcp-config']));
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual(['--tools', '']);
    expect(options).toMatchObject({ cwd: '/tmp', env: launch.env, stdin: 'ok' });
  });

  it('reports the CLI error text when the request fails', async () => {
    const run = vi.fn(async () => exec({
      ok: false, code: 1, stdout: resultJson({ is_error: true, subtype: 'success', result: 'Rate limited' }),
    }));
    await expect(runWindowWarmup(launch, run)).rejects.toThrow(/Rate limited/);
  });

  it('reports stderr when the CLI prints no result', async () => {
    const run = vi.fn(async () => exec({ ok: false, code: 1, stderr: 'Not logged in\n' }));
    await expect(runWindowWarmup(launch, run)).rejects.toThrow(/Not logged in/);
  });

  it('reports a timeout', async () => {
    const run = vi.fn(async () => exec({ ok: false, code: null, timedOut: true }));
    await expect(runWindowWarmup(launch, run)).rejects.toThrow(/timed out/);
  });
});
