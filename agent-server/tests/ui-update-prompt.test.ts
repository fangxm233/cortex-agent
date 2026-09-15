// input:  vitest, createUiUpdatePrompt, the ui-service system handlers and the shared update state
// output: coverage for the dialog prompt — fallback delegation, first-answer-wins, and the
//         applyUpdate / skipUpdate mutations resolving a pending ask()
// pos:    §3.7 unified update prompt (plan/silent-app-update.md)

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createUiUpdatePrompt } from '../src/orchestration/interactions/ui-update-prompt.js';
import type { UpdateChoice, UpdatePrompt } from '../src/domain/system/update-prompt.js';
import {
  _resetServerUpdateStatus,
  getServerUpdateStatus,
  reportServerUpdateFailed,
  reportServerUpdateInstalled,
} from '../src/domain/system/update-ui-state.js';
import { handleSystemUpdateStatus } from '../src/domain/ui-service/query/system.js';
import {
  handleSystemApplyUpdate,
  handleSystemSkipUpdate,
} from '../src/domain/ui-service/mutate/system.js';

/** Let pending microtasks (the ask() promise chain) run. */
const tick = () => new Promise<void>((r) => { setTimeout(r, 0); });

/** A fallback UpdatePrompt whose answer is supplied by the test. */
function stubChatPrompt() {
  let settle: ((choice: UpdateChoice | null) => void) | null = null;
  const ask = vi.fn(
    (_spec: { latestVersion: string }) =>
      new Promise<UpdateChoice | null>((resolve) => { settle = resolve; }),
  );
  return {
    prompt: { ask } as UpdatePrompt,
    ask,
    answer(choice: UpdateChoice | null) {
      if (!settle) throw new Error('chat prompt was never asked');
      settle(choice);
    },
  };
}

beforeEach(() => {
  _resetServerUpdateStatus();
});

describe('createUiUpdatePrompt', () => {
  it('publishes a prompting status the SPA query can read', async () => {
    const chat = stubChatPrompt();
    const prompt = createUiUpdatePrompt(chat.prompt, { fallbackMs: 60_000 });

    void prompt.ask({ latestVersion: '2026.9.20' });
    await tick();

    expect(await handleSystemUpdateStatus({})).toEqual({
      available: '2026.9.20',
      state: 'prompting',
    });
    expect(chat.ask).not.toHaveBeenCalled();
  });

  it('delegates to the chat-message prompt once the fallback timer fires', async () => {
    const chat = stubChatPrompt();
    const prompt = createUiUpdatePrompt(chat.prompt, { fallbackMs: 5 });

    const answer = prompt.ask({ latestVersion: '2026.9.20' });
    await new Promise<void>((r) => { setTimeout(r, 20); });

    expect(chat.ask).toHaveBeenCalledTimes(1);
    expect(chat.ask.mock.calls[0][0]).toEqual({ latestVersion: '2026.9.20' });

    chat.answer('apply');
    expect(await answer).toBe('apply');
    expect(getServerUpdateStatus().state).toBe('installing');
  });

  it('never arms the chat prompt when the dialog answers in time', async () => {
    const chat = stubChatPrompt();
    const prompt = createUiUpdatePrompt(chat.prompt, { fallbackMs: 20 });

    const answer = prompt.ask({ latestVersion: '2026.9.20' });
    await tick();
    await handleSystemSkipUpdate({});

    expect(await answer).toBe('skip');
    await new Promise<void>((r) => { setTimeout(r, 40); });
    expect(chat.ask).not.toHaveBeenCalled();
  });

  it('lets the first answer win when both sides are live', async () => {
    const chat = stubChatPrompt();
    const prompt = createUiUpdatePrompt(chat.prompt, { fallbackMs: 5 });

    const answer = prompt.ask({ latestVersion: '2026.9.20' });
    await new Promise<void>((r) => { setTimeout(r, 20); });
    expect(chat.ask).toHaveBeenCalledTimes(1);

    // Chat clicks first…
    chat.answer('skip');
    expect(await answer).toBe('skip');
    expect(getServerUpdateStatus()).toEqual({ available: null, state: 'idle' });

    // …and the dialog's late click is refused rather than applied on top.
    const late = await handleSystemApplyUpdate({});
    expect(late.ok && late.data.accepted).toBe(false);
    expect(getServerUpdateStatus().state).toBe('idle');
  });

  it('supersedes an older prompt instead of stranding its ask()', async () => {
    const chat = stubChatPrompt();
    const prompt = createUiUpdatePrompt(chat.prompt, { fallbackMs: 60_000 });

    const first = prompt.ask({ latestVersion: '2026.9.20' });
    await tick();
    const second = prompt.ask({ latestVersion: '2026.9.21' });
    await tick();

    // The 24h re-check took over: the first checkServerUpdate call must not hang.
    expect(await first).toBeNull();
    expect(getServerUpdateStatus()).toEqual({ available: '2026.9.21', state: 'prompting' });

    await handleSystemApplyUpdate({});
    expect(await second).toBe('apply');
  });

  it('refuses a dialog answer with no prompt pending', async () => {
    const result = await handleSystemApplyUpdate({});
    expect(result.ok && result.data).toEqual({
      accepted: false,
      status: { available: null, state: 'idle' },
    });
  });
});

describe('system.applyUpdate / system.skipUpdate', () => {
  it('applyUpdate resolves ask() with apply and moves the status to installing', async () => {
    const chat = stubChatPrompt();
    const prompt = createUiUpdatePrompt(chat.prompt, { fallbackMs: 60_000 });

    const answer = prompt.ask({ latestVersion: '2026.9.20' });
    await tick();

    const result = await handleSystemApplyUpdate({});
    expect(result.ok && result.data).toEqual({
      accepted: true,
      status: { available: '2026.9.20', state: 'installing' },
    });
    expect(await answer).toBe('apply');
  });

  it('skipUpdate resolves ask() with skip and clears the status', async () => {
    const chat = stubChatPrompt();
    const prompt = createUiUpdatePrompt(chat.prompt, { fallbackMs: 60_000 });

    const answer = prompt.ask({ latestVersion: '2026.9.20' });
    await tick();

    const result = await handleSystemSkipUpdate({});
    expect(result.ok && result.data).toEqual({
      accepted: true,
      status: { available: null, state: 'idle' },
    });
    expect(await answer).toBe('skip');
  });
});

describe('install outcome reporting', () => {
  it('reports a finished install as restarting, keeping the target version', async () => {
    const chat = stubChatPrompt();
    const prompt = createUiUpdatePrompt(chat.prompt, { fallbackMs: 60_000 });
    void prompt.ask({ latestVersion: '2026.9.20' });
    await tick();
    await handleSystemApplyUpdate({});

    reportServerUpdateInstalled();
    expect(await handleSystemUpdateStatus({})).toEqual({
      available: '2026.9.20',
      state: 'restarting',
    });
  });

  it('surfaces a failed install with its message instead of pretending success', async () => {
    const chat = stubChatPrompt();
    const prompt = createUiUpdatePrompt(chat.prompt, { fallbackMs: 60_000 });
    void prompt.ask({ latestVersion: '2026.9.20' });
    await tick();
    await handleSystemApplyUpdate({});

    reportServerUpdateFailed('npm install -g exited with code 1\nEACCES');
    expect(await handleSystemUpdateStatus({})).toEqual({
      available: '2026.9.20',
      state: 'failed',
      error: 'npm install -g exited with code 1\nEACCES',
    });
  });
});
