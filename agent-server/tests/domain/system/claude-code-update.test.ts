import { describe, expect, it, vi } from 'vitest';
import type { ExecOptions, ExecResult } from '../../../src/core/exec-async.js';
import {
  ClaudeCodeUpdater, compareVersions, parseClaudeVersion, updateOutcome,
} from '../../../src/domain/system/claude-code-update.js';
import {
  claudeUpdateNoticeAction, claudeUpdateRequired,
} from '../../../src/domain/system/claude-code-required.js';

const REAL_ERROR = "API Error: 400 Claude Code 2.1.280 does not support this model; version 2.1.290 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.";

function exec(stdout: string, ok = true, stderr = ''): ExecResult {
  return { ok, code: ok ? 0 : 1, signal: null, timedOut: false, stdout, stderr };
}

/** A fake toolchain: `claude --version` reads `installed`, `claude update` moves it to `target`. */
function toolchain(opts: { installed: string | null; latest: string; target?: string; updateOk?: boolean }) {
  let installed = opts.installed;
  const run = vi.fn(async (file: string, args: string[], _opts?: ExecOptions) => {
    if (file === 'claude' && args[0] === '--version') {
      return installed ? exec(`${installed} (Claude Code)\n`) : { ...exec('', false), error: 'spawn claude ENOENT' };
    }
    if (file === 'claude' && args[0] === 'update') {
      if (opts.target) installed = opts.target;
      return exec('update output\nlast line', opts.updateOk ?? true);
    }
    return exec(`${opts.latest}\n`);
  });
  const onInstalled = vi.fn();
  const updater = new ClaudeCodeUpdater({ run, now: () => '2026-11-10T00:00:00.000Z', onInstalled });
  return { updater, run, onInstalled };
}

describe('claude update-required detection', () => {
  it('reads both versions from the real Claude Code error', () => {
    expect(claudeUpdateRequired(REAL_ERROR)).toEqual({ installed: '2.1.280', required: '2.1.290' });
    expect(claudeUpdateNoticeAction(REAL_ERROR)).toEqual({ kind: 'update-claude-code', required: '2.1.290' });
  });

  it('still asks for an update when only the instruction is present', () => {
    expect(claudeUpdateRequired('API Error: 400 please run `claude update` and retry')).toEqual({});
  });

  it('leaves other 400s and rate limits alone', () => {
    expect(claudeUpdateRequired('API Error: 400 {"type":"invalid_request_error","message":"prompt is too long"}')).toBeNull();
    expect(claudeUpdateRequired("You've hit your session limit · resets 1am")).toBeNull();
    expect(claudeUpdateNoticeAction('API Error: 500 overloaded')).toBeUndefined();
  });
});

describe('version helpers', () => {
  it('parses `claude --version` and compares numerically', () => {
    expect(parseClaudeVersion('2.1.322 (Claude Code)')).toBe('2.1.322');
    expect(compareVersions('2.1.290', '2.1.280')).toBeGreaterThan(0);
    expect(compareVersions('2.10.0', '2.9.99')).toBeGreaterThan(0);
    expect(compareVersions('2.1.3', '2.1.3')).toBe(0);
  });

  it('judges an update by the version it left behind', () => {
    expect(updateOutcome(exec('', false), '2.1.280', '2.1.300', '2.1.300').state).toBe('idle');
    expect(updateOutcome(exec('ok'), '2.1.300', '2.1.300', '2.1.300').state).toBe('idle');
    const stuck = updateOutcome(exec('Use brew upgrade', true), '2.1.280', '2.1.280', '2.1.300');
    expect(stuck).toMatchObject({ state: 'failed', failure: 'update_failed', detail: 'Use brew upgrade' });
  });
});

describe('ClaudeCodeUpdater', () => {
  it('check reports the installed and latest versions', async () => {
    const { updater } = toolchain({ installed: '2.1.280', latest: '2.1.322' });
    const status = await updater.check();
    expect(status).toEqual({
      installed: '2.1.280', latest: '2.1.322', state: 'idle', checkedAt: '2026-11-10T00:00:00.000Z',
    });
  });

  it('check fails as not_installed when claude is missing', async () => {
    const { updater } = toolchain({ installed: null, latest: '2.1.322' });
    const status = await updater.check();
    expect(status).toMatchObject({ installed: null, latest: '2.1.322', state: 'failed', failure: 'not_installed' });
  });

  it('update moves the version, reports updating meanwhile, and recycles idle sessions', async () => {
    const { updater, onInstalled } = toolchain({ installed: '2.1.280', latest: '2.1.322', target: '2.1.322' });
    await updater.check();
    const pending = updater.update();
    expect(updater.getStatus().state).toBe('updating');
    expect(await pending).toMatchObject({ installed: '2.1.322', state: 'idle' });
    expect(onInstalled).toHaveBeenCalledTimes(1);
  });

  it('an update that changes nothing while behind is a failure with the CLI output', async () => {
    const { updater, onInstalled } = toolchain({ installed: '2.1.280', latest: '2.1.322' });
    await updater.check();
    expect(await updater.update()).toMatchObject({ state: 'failed', failure: 'update_failed', detail: 'update output\nlast line' });
    expect(onInstalled).not.toHaveBeenCalled();
  });

  it('runs one update for concurrent requests', async () => {
    const { updater, run } = toolchain({ installed: '2.1.280', latest: '2.1.322', target: '2.1.322' });
    await Promise.all([updater.update(), updater.update()]);
    expect(run.mock.calls.filter(([, args]) => args[0] === 'update')).toHaveLength(1);
  });

  it('an update requested during a check still runs after it', async () => {
    const { updater } = toolchain({ installed: '2.1.280', latest: '2.1.322', target: '2.1.322' });
    const check = updater.check();
    const update = updater.update();
    await check;
    expect(await update).toMatchObject({ installed: '2.1.322', state: 'idle' });
  });

  it('runs claude update with the auto-updater allowed', async () => {
    vi.stubEnv('DISABLE_AUTOUPDATER', '1');
    const { updater, run } = toolchain({ installed: '2.1.280', latest: '2.1.322', target: '2.1.322' });
    await updater.update();
    const call = run.mock.calls.find(([, args]) => args[0] === 'update');
    expect(call?.[2]?.env?.DISABLE_AUTOUPDATER).toBeUndefined();
    vi.unstubAllEnvs();
  });
});

describe('admin notice for chats without the card button', () => {
  it('posts once per required version, and never for web chats', async () => {
    const { ctx } = await import('../../../src/domain/scheduling/job-registry.js');
    const { noticeClaudeUpdateRequired, _resetClaudeUpdateNotices } = await import('../../../src/domain/system/claude-code-required.js');
    const postMessage = vi.fn(async () => ({ conduit: 'C-admin' }));
    const previous = ctx.adapter;
    ctx.adapter = { postMessage } as unknown as typeof ctx.adapter;
    _resetClaudeUpdateNotices();
    try {
      noticeClaudeUpdateRequired(REAL_ERROR, 'web:abc');
      noticeClaudeUpdateRequired(REAL_ERROR, 'slack:C1');
      noticeClaudeUpdateRequired(REAL_ERROR, null);
      noticeClaudeUpdateRequired('API Error: 400 prompt is too long', null);
      await Promise.resolve();
      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(postMessage.mock.calls[0])).toContain('2.1.290');
    } finally {
      ctx.adapter = previous;
      _resetClaudeUpdateNotices();
    }
  });
});
