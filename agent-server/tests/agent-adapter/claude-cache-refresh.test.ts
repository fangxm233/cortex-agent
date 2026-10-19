import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import {
  CACHE_REFRESH_PROMPT, cacheRefreshLaunch, forkRefreshArgs, refreshCost, runCacheRefresh,
  type CacheRefreshChild, type CacheRefreshLaunch,
} from '../../src/agent-adapter/claude/cache-refresh.js';
import { claudeProcessLaunch, launchFromSpec } from '../../src/agent-adapter/claude/session-options.js';
import { engineSpecFixture } from '../engine-spec-fixture.js';

const SID = '0c6d9a52-3f1e-4b7a-8d2c-9e4f1a6b3c70';

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed: Array<NodeJS.Signals | undefined> = [];
  written = '';

  constructor() {
    super();
    this.stdin.on('data', (chunk) => { this.written += String(chunk); });
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killed.push(signal);
    this.signalCode = signal ?? 'SIGTERM';
    return true;
  }

  emitLine(record: object): void {
    this.stdout.write(JSON.stringify(record) + '\n');
  }
}

function transcriptWithCost(total: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-cache-refresh-'));
  const file = path.join(dir, `${SID}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'cost-state', sessionId: SID, totalCostUSD: total }) + '\n');
  return file;
}

function launchFor(transcriptPath: string): CacheRefreshLaunch {
  return { command: 'claude', args: ['-p'], env: {}, cwd: '/tmp', sessionId: SID, transcriptPath };
}

const RESULT = {
  type: 'result', subtype: 'success', is_error: false, total_cost_usd: 133.231,
  usage: { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 165_180, cache_creation_input_tokens: 1_017 },
  modelUsage: { 'claude-old': {}, 'claude-opus-5-5': {} },
};

describe('forkRefreshArgs', () => {
  test('turns either session identity into a one-turn fork that persists nothing', () => {
    const fork = ['--resume', SID, '--fork-session', '--no-session-persistence', '--max-turns', '1'];
    assert.deepEqual(forkRefreshArgs(['-p', '--session-id', SID, '--x'], SID), ['-p', ...fork, '--x']);
    assert.deepEqual(forkRefreshArgs(['-p', '--resume', SID], SID), ['-p', ...fork]);
  });

  test('refuses an argv that names another session', () => {
    assert.throws(() => forkRefreshArgs(['-p', '--resume', 'other'], SID), /does not name session/);
  });
});

describe('cacheRefreshLaunch', () => {
  test('is the next turn\'s launch except the fork flags and the hooks', () => {
    const spec = engineSpecFixture({ sessionId: SID, resume: true, channel: 'web:abc', isUserInitiated: true });
    const turn = claudeProcessLaunch({ ...launchFromSpec(spec), needsResume: true });
    const fork = cacheRefreshLaunch(spec);
    const settingsAt = turn.args.indexOf('--settings');
    const expected = forkRefreshArgs(turn.args, SID);
    expected[settingsAt + 1] = JSON.stringify({ hooks: {} });
    assert.deepEqual(fork.args, expected);
    assert.equal(fork.env.CORTEX_SESSION_ID, turn.env.CORTEX_SESSION_ID);
    assert.equal(fork.sessionId, SID);
    assert.ok(fork.transcriptPath.endsWith(`${SID}.jsonl`));
  });

  test('needs a backend session', () => {
    assert.throws(() => cacheRefreshLaunch(engineSpecFixture({ sessionId: null })), /backend session/);
  });
});

describe('refreshCost', () => {
  test('subtracts the restored history and never goes negative', () => {
    assert.ok(Math.abs(refreshCost(133.231, 133.19) - 0.041) < 1e-9);
    assert.equal(refreshCost(1, 2), 0);
    assert.equal(refreshCost(undefined, 2), 0);
  });
});

describe('runCacheRefresh', () => {
  test('sends one message and reports the request usage, model and cost', async () => {
    const child = new FakeChild();
    let spawned: { command: string; args: string[] } | null = null;
    const pending = runCacheRefresh(launchFor(transcriptWithCost(133.19)), {
      spawn: (command, args) => { spawned = { command, args }; return child as unknown as CacheRefreshChild; },
    });
    child.emitLine({ type: 'system', subtype: 'init' });
    child.emitLine({ type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }] } });
    child.emitLine(RESULT);
    const result = await pending;
    assert.deepEqual(spawned, { command: 'claude', args: ['-p'] });
    assert.equal(JSON.parse(child.written).message.content, CACHE_REFRESH_PROMPT);
    assert.deepEqual(result.usage, { inputTokens: 2, outputTokens: 4, cacheReadTokens: 165_180, cacheWriteTokens: 1_017 });
    assert.equal(result.model, 'claude-opus-5-5');
    assert.ok(Math.abs(result.costUsd - 0.041) < 1e-9);
    assert.equal(child.stdin.writableEnded, true);
  });

  test('a timeout kills the fork and rejects', async () => {
    const child = new FakeChild();
    const pending = runCacheRefresh(launchFor('/nonexistent.jsonl'), {
      spawn: () => child as unknown as CacheRefreshChild, timeoutMs: 20,
    });
    await assert.rejects(pending, /no result within 20ms/);
    assert.deepEqual(child.killed, [undefined]);
  });

  test('an exit before the result rejects with the stderr tail', async () => {
    const child = new FakeChild();
    const pending = runCacheRefresh(launchFor('/nonexistent.jsonl'), {
      spawn: () => child as unknown as CacheRefreshChild,
    });
    child.stderr.write('No conversation found\n');
    setTimeout(() => child.emit('close', 1), 5);
    await assert.rejects(pending, /exited 1 before a result: No conversation found/);
  });

  test('an error result rejects, a max-turns stop still counts', async () => {
    const failing = new FakeChild();
    const failed = runCacheRefresh(launchFor('/nonexistent.jsonl'), {
      spawn: () => failing as unknown as CacheRefreshChild,
    });
    failing.emitLine({ ...RESULT, is_error: true, result: 'API Error: 500' });
    await assert.rejects(failed, /refresh failed: API Error: 500/);

    const stopped = new FakeChild();
    const counted = runCacheRefresh(launchFor('/nonexistent.jsonl'), {
      spawn: () => stopped as unknown as CacheRefreshChild,
    });
    stopped.emitLine({ ...RESULT, is_error: true, subtype: 'error_max_turns' });
    assert.equal((await counted).usage.cacheReadTokens, 165_180);
  });
});
