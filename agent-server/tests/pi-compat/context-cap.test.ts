import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import type { PiSdkModule } from '../../src/core/pi-sdk.js';
import { createRuntimeSettings } from '../../src/agent-adapter/pi/runtime-settings.js';

const settings = vi.hoisted(() => ({ maxContextTokens: null as number | null }));
vi.mock('../../src/core/settings.js', () => ({ getSettings: () => settings }));

const sdk = { SettingsManager, hasTrustRequiringProjectResources: () => false } as unknown as PiSdkModule;

function managerWithReserve(reserveTokens: number): SettingsManager {
  const root = mkdtempSync(join(tmpdir(), 'pi-context-cap-'));
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ compaction: { reserveTokens } }));
  return createRuntimeSettings(sdk, cwd, agentDir);
}

/** PI hands the settings manager its full model object, window included. */
function model(contextWindow: number) {
  return { provider: 'p', id: 'm', contextWindow } as { provider: string; id: string };
}

/** The token count past which PI compacts: `contextWindow - reserveTokens`. */
function threshold(manager: SettingsManager, contextWindow: number): number {
  return contextWindow - manager.getCompactionSettings(model(contextWindow)).reserveTokens;
}

afterEach(() => { settings.maxContextTokens = null; });

test('without a cap PI keeps its own reserve', () => {
  const manager = managerWithReserve(16_384);
  expect(manager.getCompactionReserveTokens(model(1_000_000))).toBe(16_384);
});

test('a window above the cap compacts at cap minus reserve; a smaller window is untouched', () => {
  settings.maxContextTokens = 200_000;
  const manager = managerWithReserve(16_384);
  expect(threshold(manager, 1_000_000)).toBe(200_000 - 16_384);
  expect(threshold(manager, 128_000)).toBe(128_000 - 16_384);
});

test('a reserve over half the cap is bounded so an empty context never compacts', () => {
  settings.maxContextTokens = 100_000;
  const manager = managerWithReserve(131_072);
  expect(threshold(manager, 272_000)).toBe(50_000);
});

test('a changed cap reaches a manager that already exists', () => {
  const manager = managerWithReserve(16_384);
  expect(threshold(manager, 272_000)).toBe(272_000 - 16_384);
  settings.maxContextTokens = 150_000;
  expect(threshold(manager, 272_000)).toBe(150_000 - 16_384);
});
