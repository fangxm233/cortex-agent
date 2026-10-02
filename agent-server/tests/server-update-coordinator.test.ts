import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServerUpdateCoordinator } from '../src/domain/system/server-update-check.js';
import { createUiUpdatePrompt } from '../src/orchestration/interactions/ui-update-prompt.js';
import type { UpdateState } from '../src/domain/system/update-state.js';
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

function fixture() {
  let state: UpdateState = {};
  const prompt = createUiUpdatePrompt({ ask: async () => null });
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
    expect(await f.coordinator.check()).toEqual(available);
    expect(f.getLatest).toHaveBeenCalledTimes(1);
    expect(f.ask).toHaveBeenCalledTimes(1);
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
