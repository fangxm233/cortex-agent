import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServerUpdateCoordinator } from '../src/domain/system/server-update-check.js';
import { createUiUpdatePrompt } from '../src/orchestration/interactions/ui-update-prompt.js';
import type { UpdateState } from '../src/domain/system/update-state.js';
import type { UpdateChoice, UpdatePrompt } from '../src/domain/system/update-prompt.js';
import {
  _resetServerUpdateStatus, answerServerUpdatePrompt, getServerUpdateStatus,
  reportServerUpdateInstalled,
} from '../src/domain/system/update-ui-state.js';
import { handleSystemApplyUpdate } from '../src/domain/ui-service/mutate/system.js';

const settings = vi.hoisted(() => ({ serverUpdateDisable: false }));
vi.mock('../src/core/settings.js', () => ({ getSettings: () => settings }));
const available = { status: 'available', update: { version: '9999.1.1' } };
const failed = { status: 'error', reason: 'check_failed' };
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function fixture(fallback: UpdatePrompt = { ask: async () => null }, fallbackMs = 600_000) {
  let state: UpdateState = {};
  const prompt = createUiUpdatePrompt(fallback, { fallbackMs });
  const ask = vi.spyOn(prompt, 'ask');
  const getLatest = vi.fn(async () => '9999.1.1' as string | null);
  const spawnInstall = vi.fn();
  const loadState = vi.fn(() => state);
  const saveState = vi.fn((next: UpdateState) => { state = next; });
  const coordinator = createServerUpdateCoordinator({ prompt, getLatest, spawnInstall, loadState, saveState });
  return { coordinator, ask, getLatest, spawnInstall, loadState, saveState };
}

beforeEach(() => {
  vi.stubEnv('CORTEX_REPO', '');
  settings.serverUpdateDisable = false;
  _resetServerUpdateStatus();
});
afterEach(async () => {
  answerServerUpdatePrompt('cancel');
  await tick();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('shared server update discovery', () => {
  it('returns available with a published prompt without waiting or installing', async () => {
    const f = fixture();
    expect(await f.coordinator.check()).toEqual(available);
    expect(getServerUpdateStatus()).toEqual({ state: 'prompting', available: '9999.1.1' });
    expect(f.spawnInstall).not.toHaveBeenCalled();
    expect(f.saveState).toHaveBeenCalledTimes(1);
  });

  it('coalesces background/manual lookups and reuses a pending prompt', async () => {
    const f = fixture();
    let resolve!: (version: string) => void;
    f.getLatest.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const background = f.coordinator.check();
    const manual = f.coordinator.check();
    await tick();
    resolve('9999.1.1');
    expect(await background).toEqual(available);
    expect(await manual).toEqual(available);
    expect(f.getLatest).toHaveBeenCalledTimes(1);
    f.getLatest.mockResolvedValue('9999.1.1');
    expect(await f.coordinator.check()).toEqual(available);
    expect(f.getLatest).toHaveBeenCalledTimes(2);
    expect(f.ask).toHaveBeenCalledTimes(1);
    answerServerUpdatePrompt('apply');
    expect(answerServerUpdatePrompt('apply')).toBe(false);
    await tick();
    expect(f.spawnInstall).toHaveBeenCalledTimes(1);
  });

  it('supersedes changed releases without losing the new prompt ownership', async () => {
    const f = fixture();
    await f.coordinator.check();
    const firstAnswer = f.ask.mock.results[0].value;
    f.getLatest.mockResolvedValue('9999.1.2');
    const next = { status: 'available', update: { version: '9999.1.2' } };
    expect(await f.coordinator.check()).toEqual(next);
    expect(await firstAnswer).toBeNull();
    expect(getServerUpdateStatus()).toEqual({ state: 'prompting', available: '9999.1.2' });
    expect(await f.coordinator.check()).toEqual(next);
    expect(f.ask).toHaveBeenCalledTimes(2);
    expect(f.getLatest).toHaveBeenCalledTimes(3);
    expect(f.spawnInstall).not.toHaveBeenCalled();
    answerServerUpdatePrompt('apply');
    await tick();
    expect(f.spawnInstall).toHaveBeenCalledTimes(1);
    expect(f.saveState).toHaveBeenLastCalledWith(expect.objectContaining({ lastPromptedVersion: '9999.1.2' }));
  });

  it.each(['apply', 'skip', 'reject'] as const)('ignores a superseded prompt late %s', async (choice) => {
    const f = fixture();
    let resolve!: (choice: UpdateChoice) => void;
    let reject!: (error: Error) => void;
    f.ask.mockImplementationOnce(() => new Promise((done, fail) => { resolve = done; reject = fail; }));
    await f.coordinator.check();
    f.getLatest.mockResolvedValue('9999.1.2');
    await f.coordinator.check();
    if (choice === 'reject') reject(new Error('stale failure'));
    else resolve(choice);
    await tick();
    expect(f.spawnInstall).not.toHaveBeenCalled();
    expect(f.saveState).toHaveBeenCalledTimes(2);
    expect(getServerUpdateStatus()).toEqual({ state: 'prompting', available: '9999.1.2' });
    await f.coordinator.check();
    expect(f.ask).toHaveBeenCalledTimes(2);
    answerServerUpdatePrompt('apply');
    await tick();
    expect(f.spawnInstall).toHaveBeenCalledTimes(1);
  });

  it.each(['null', 'invalid', 'reject'])('reports a fresh %s lookup failure despite pending consent', async (failure) => {
    const f = fixture();
    await f.coordinator.check();
    if (failure === 'reject') f.getLatest.mockRejectedValueOnce(new Error('registry down'));
    else f.getLatest.mockResolvedValueOnce(failure === 'null' ? null : 'invalid');
    expect(await f.coordinator.check()).toEqual(failed);
    expect(f.getLatest).toHaveBeenCalledTimes(2);
    expect(f.ask).toHaveBeenCalledTimes(1);
    expect(f.spawnInstall).not.toHaveBeenCalled();
    expect(await f.coordinator.check()).toEqual(available);
    expect(f.ask).toHaveBeenCalledTimes(1);
  });

  it('cancels pending consent when fresh discovery says current', async () => {
    const f = fixture();
    await f.coordinator.check();
    const answer = f.ask.mock.results[0].value;
    f.getLatest.mockResolvedValue('2020.1.1');
    expect(await f.coordinator.check()).toEqual({ status: 'current' });
    expect(getServerUpdateStatus()).toEqual({ state: 'idle', available: null });
    expect(await answer).toBe('cancel');
    expect(answerServerUpdatePrompt('apply')).toBe(false);
    expect(f.spawnInstall).not.toHaveBeenCalled();
  });

  it('does not reopen consent if installation starts during fresh discovery', async () => {
    const f = fixture();
    await f.coordinator.check();
    let resolve!: (version: string) => void;
    f.getLatest.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const check = f.coordinator.check();
    await tick();
    answerServerUpdatePrompt('apply');
    await tick();
    resolve('9999.1.2');
    expect(await check).toEqual({ status: 'skipped', reason: 'update_in_progress' });
    expect(f.ask).toHaveBeenCalledTimes(1);
    expect(f.spawnInstall).toHaveBeenCalledTimes(1);
    expect(getServerUpdateStatus().state).toBe('installing');
  });

  it('performs fresh discovery after current and after a cancelled prompt', async () => {
    const f = fixture();
    f.getLatest.mockResolvedValueOnce('2020.1.1');
    expect(await f.coordinator.check()).toEqual({ status: 'current' });
    expect(await f.coordinator.check()).toEqual(available);
    answerServerUpdatePrompt('cancel');
    await tick();
    expect(await f.coordinator.check()).toEqual(available);
    expect(f.getLatest).toHaveBeenCalledTimes(3);
    expect(f.ask).toHaveBeenCalledTimes(2);
  });

  it('requires consent exactly once and skips installing/restarting', async () => {
    const f = fixture();
    await f.coordinator.check();
    const first = await handleSystemApplyUpdate({});
    const second = await handleSystemApplyUpdate({});
    expect(first.ok && first.data.accepted).toBe(true);
    expect(second.ok && second.data.accepted).toBe(false);
    await tick();
    expect(f.spawnInstall).toHaveBeenCalledTimes(1);
    expect(await f.coordinator.check()).toEqual({ status: 'skipped', reason: 'update_in_progress' });
    reportServerUpdateInstalled();
    expect(await f.coordinator.check()).toEqual({ status: 'skipped', reason: 'update_in_progress' });
    expect(f.getLatest).toHaveBeenCalledTimes(1);
  });

  it('preserves skip policy and permits a later different release', async () => {
    const f = fixture();
    await f.coordinator.check();
    answerServerUpdatePrompt('skip');
    await tick();
    expect(await f.coordinator.check()).toEqual({ status: 'skipped', reason: 'version_skipped' });
    expect(f.ask).toHaveBeenCalledTimes(1);
    f.getLatest.mockResolvedValue('9999.1.2');
    expect(await f.coordinator.check()).toEqual({ status: 'available', update: { version: '9999.1.2' } });
  });

  it.each(['disabled', 'dev_mode'])('preserves %s policy without discovery', async (reason) => {
    const f = fixture();
    if (reason === 'disabled') settings.serverUpdateDisable = true;
    else vi.stubEnv('CORTEX_REPO', process.cwd());
    expect(await f.coordinator.check()).toEqual({ status: 'skipped', reason });
    expect(f.getLatest).not.toHaveBeenCalled();
    expect(f.ask).not.toHaveBeenCalled();
  });

  it.each([null, '', 'not-a-version'])('reports failed/invalid lookup %s as error, never current', async (value) => {
    const f = fixture();
    f.getLatest.mockResolvedValue(value);
    expect(await f.coordinator.check()).toEqual(failed);
    expect(f.ask).not.toHaveBeenCalled();
  });

  it('catches discovery exceptions and permits retry', async () => {
    const f = fixture();
    f.getLatest.mockRejectedValueOnce(new Error('network down'));
    expect(await f.coordinator.check()).toEqual(failed);
    expect(await f.coordinator.check()).toEqual(available);
  });

  it('bounds a stalled lookup and never prompts on its late completion', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let resolve!: (version: string) => void;
    f.getLatest.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const check = f.coordinator.check();
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await check).toEqual(failed);
    resolve('9999.1.1');
    await tick();
    expect(f.ask).not.toHaveBeenCalled();
  });

  it('reports persistence exceptions as errors before opening a prompt', async () => {
    const f = fixture();
    f.saveState.mockImplementation(() => { throw new Error('disk full'); });
    expect(await f.coordinator.check()).toEqual(failed);
    expect(f.ask).not.toHaveBeenCalled();
  });

  it('settles a real wrapper fallback failure and retries chat on the next check', async () => {
    vi.useFakeTimers();
    const fallback = { ask: vi.fn().mockRejectedValueOnce(new Error('chat unavailable')).mockResolvedValueOnce('apply') };
    const f = fixture(fallback, 5);
    expect(await f.coordinator.check()).toEqual(available);
    const settled = vi.fn();
    void f.ask.mock.results[0].value.then(settled);
    await vi.advanceTimersByTimeAsync(5);
    expect(settled).toHaveBeenCalledWith(null);
    expect(getServerUpdateStatus()).toEqual({ state: 'idle', available: null });
    expect(f.spawnInstall).not.toHaveBeenCalled();
    expect(await f.coordinator.check()).toEqual(available);
    expect(f.ask).toHaveBeenCalledTimes(2);
    expect(f.getLatest).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5);
    expect(fallback.ask).toHaveBeenCalledTimes(2);
    expect(f.spawnInstall).toHaveBeenCalledTimes(1);
    expect(getServerUpdateStatus().state).toBe('installing');
  });

  it('contains asynchronous prompt failures rather than leaking a rejection', async () => {
    const f = fixture();
    f.ask.mockRejectedValue(new Error('prompt failed'));
    expect(await f.coordinator.check()).toEqual(failed);
    await tick();
    expect(getServerUpdateStatus()).toMatchObject({ state: 'failed', error: 'prompt failed' });
    expect(f.spawnInstall).not.toHaveBeenCalled();
  });

  it('contains a prompt rejection arriving after discovery has returned', async () => {
    const f = fixture();
    let reject!: (error: Error) => void;
    f.ask.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    expect(await f.coordinator.check()).toEqual(available);
    reject(new Error('late prompt failure'));
    await tick();
    expect(getServerUpdateStatus()).toMatchObject({ state: 'failed', error: 'late prompt failure' });
    expect(f.spawnInstall).not.toHaveBeenCalled();
  });

  it('does not install if saving the consent decision fails', async () => {
    const f = fixture();
    await f.coordinator.check();
    f.saveState.mockImplementation(() => { throw new Error('disk full'); });
    answerServerUpdatePrompt('apply');
    await tick();
    expect(getServerUpdateStatus()).toMatchObject({ state: 'failed', error: 'disk full' });
    expect(f.spawnInstall).not.toHaveBeenCalled();
  });

  it('reports synchronous installation failures and allows retry', async () => {
    const f = fixture();
    f.spawnInstall.mockImplementation(() => { throw new Error('spawn failed'); });
    await f.coordinator.check();
    answerServerUpdatePrompt('apply');
    await tick();
    expect(getServerUpdateStatus()).toMatchObject({ state: 'failed', error: 'spawn failed' });
    expect(await f.coordinator.check()).toEqual(available);
  });
});
