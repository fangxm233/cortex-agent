import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as sdk from '@earendil-works/pi-coding-agent';
import { createRuntimeSettings } from '../../src/agent-adapter/pi/runtime-settings.js';

vi.mock('../../src/core/settings.js', () => ({ getSettings: () => ({ maxContextTokens: null }) }));

const selected = 'C:\\Cortex tools\\便携 Git\\bin\\bash.exe';
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let cwd: string;
let agentDir: string;

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { ...platform, value });
}

function configure(global: object = {}, project: object = {}): void {
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(global));
  writeFileSync(join(cwd, '.pi', 'settings.json'), JSON.stringify(project));
}

beforeEach(() => {
  const root = mkdtempSync(join(process.env.CORTEX_HOME!, 'selected-bash-'));
  cwd = join(root, 'workspace');
  agentDir = join(root, 'agent');
  mkdirSync(join(cwd, '.pi'), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  configure();
  new sdk.ProjectTrustStore(agentDir).set(cwd, true);
  setPlatform('win32');
  vi.stubEnv('CORTEX_GIT_BASH_PATH', selected);
});

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.unstubAllEnvs();
});

test('selected Bash is runtime-only, survives awaited SDK reload and does not persist via another setter', async () => {
  const manager = createRuntimeSettings(sdk, cwd, agentDir);
  expect(manager.getShellPath()).toBe(selected);
  expect(manager.getGlobalSettings().shellPath).toBeUndefined();
  expect(manager.getProjectSettings().shellPath).toBeUndefined();
  manager.setQuietStartup(true);
  await manager.flush();
  await manager.reload();
  expect(manager.getShellPath()).toBe(selected);
  expect(JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))).toEqual({ quietStartup: true });
  expect(JSON.parse(readFileSync(join(cwd, '.pi', 'settings.json'), 'utf8'))).toEqual({});
});

test.each([
  [{ shellPath: 'C:/user/bash.exe' }, {}, 'C:/user/bash.exe'],
  [{ shellPath: 'C:/user/bash.exe' }, { shellPath: 'C:/project/bash.exe' }, 'C:/project/bash.exe'],
  [{ shellPath: '' }, {}, ''],
] as const)('keeps SDK explicit settings precedence: %j / %j', async (global, project, expected) => {
  configure(global, project);
  const manager = createRuntimeSettings(sdk, cwd, agentDir);
  expect(manager.getShellPath()).toBe(expected);
  await manager.reload();
  expect(manager.getShellPath()).toBe(expected);
});

test('reload observes added, changed and removed explicit settings', async () => {
  const manager = createRuntimeSettings(sdk, cwd, agentDir);
  expect(manager.getShellPath()).toBe(selected);
  configure({ shellPath: 'C:/user/bash.exe' });
  await manager.reload();
  expect(manager.getShellPath()).toBe('C:/user/bash.exe');
  configure({}, { shellPath: 'C:/project/bash.exe' });
  await manager.reload();
  expect(manager.getShellPath()).toBe('C:/project/bash.exe');
  configure();
  await manager.reload();
  expect(manager.getShellPath()).toBe(selected);
});

test('SDK runtime overrides and persisted shell setters still win', async () => {
  const manager = createRuntimeSettings(sdk, cwd, agentDir);
  manager.applyOverrides({ shellPath: 'C:/override/bash.exe' });
  expect(manager.getShellPath()).toBe('C:/override/bash.exe');
  await manager.reload();
  expect(manager.getShellPath()).toBe(selected);
  manager.setShellPath('C:/setter/bash.exe');
  await manager.flush();
  await manager.reload();
  expect(manager.getShellPath()).toBe('C:/setter/bash.exe');
});

test('untrusted project settings stay ignored until the SDK grants trust', async () => {
  configure({}, { shellPath: 'C:/untrusted/bash.exe' });
  new sdk.ProjectTrustStore(agentDir).set(cwd, false);
  mkdirSync(join(cwd, '.pi', 'extensions'), { recursive: true });
  writeFileSync(join(cwd, '.pi', 'extensions', 'untrusted.ts'), 'throw new Error("must not load");');
  const manager = createRuntimeSettings(sdk, cwd, agentDir);
  expect(manager.isProjectTrusted()).toBe(false);
  expect(manager.getShellPath()).toBe(selected);
  manager.setProjectTrusted(true);
  expect(manager.getShellPath()).toBe('C:/untrusted/bash.exe');
  manager.setProjectTrusted(false);
  await manager.reload();
  expect(manager.getShellPath()).toBe(selected);
});

test.each(['linux', 'darwin'])('%s ignores native selection and retains explicit shell settings', async (os) => {
  setPlatform(os);
  const manager = createRuntimeSettings(sdk, cwd, agentDir);
  expect(manager.getShellPath()).toBeUndefined();
  configure({ shellPath: '/custom/bash' });
  await manager.reload();
  expect(manager.getShellPath()).toBe('/custom/bash');
});

test.each([undefined, ''])('absent/empty native selection keeps SDK default (%s)', (value) => {
  vi.stubEnv('CORTEX_GIT_BASH_PATH', value);
  expect(createRuntimeSettings(sdk, cwd, agentDir).getShellPath()).toBeUndefined();
});
