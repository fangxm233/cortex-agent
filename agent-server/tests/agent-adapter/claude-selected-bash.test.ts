import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { buildClaudeEnv } from '../../src/agent-adapter/claude/spawn-args.js';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const selected = 'C:\\Cortex tools\\便携 Git\\bin\\bash.exe';
const selectedPath = 'C:\\Cortex tools\\node;C:\\Cortex tools\\Git\\cmd;C:\\Windows\\System32';

beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  vi.stubEnv('CORTEX_GIT_BASH_PATH', selected);
  vi.stubEnv('CLAUDE_CODE_GIT_BASH_PATH', undefined);
  vi.stubEnv('PATH', selectedPath);
});

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.unstubAllEnvs();
});

function launch(extra?: Record<string, string>, pinned?: NodeJS.ProcessEnv, unset?: string[]) {
  return buildClaudeEnv('test-channel', 'test-session', null, null, undefined, extra, undefined, pinned, unset);
}

test('Windows child receives native-selected Bash and unchanged Node/npm/Git PATH', () => {
  vi.stubEnv('CLAUDE_CODE_UNRELATED_CONTROL', 'strip-me');
  const env = launch();
  expect(env.CLAUDE_CODE_GIT_BASH_PATH).toBe(selected);
  expect(env.CORTEX_GIT_BASH_PATH).toBe(selected);
  expect(env.PATH).toBe(selectedPath);
  expect(env.CLAUDE_CODE_UNRELATED_CONTROL).toBeUndefined();
  expect(process.env.CLAUDE_CODE_GIT_BASH_PATH).toBeUndefined();
});

test.each(['C:/explicit/bash.exe', ''])('preserves explicit inherited Claude Bash (%s)', (explicit) => {
  vi.stubEnv('CLAUDE_CODE_GIT_BASH_PATH', explicit);
  expect(launch().CLAUDE_CODE_GIT_BASH_PATH).toBe(explicit);
});

test('per-spawn settings and deletions retain final precedence', () => {
  const extra = { CLAUDE_CODE_GIT_BASH_PATH: 'D:/user/bash.exe', PATH: 'D:/user/node' };
  const env = launch(extra);
  expect(env.CLAUDE_CODE_GIT_BASH_PATH).toBe(extra.CLAUDE_CODE_GIT_BASH_PATH);
  expect(env.PATH).toBe(extra.PATH);
  expect(launch(extra, undefined, ['CLAUDE_CODE_GIT_BASH_PATH']).CLAUDE_CODE_GIT_BASH_PATH).toBeUndefined();
});

test('pinned env does not acquire host selection or PATH', () => {
  const env = launch(undefined, {});
  expect(env.CLAUDE_CODE_GIT_BASH_PATH).toBeUndefined();
  expect(env.CORTEX_GIT_BASH_PATH).toBeUndefined();
  expect(env.PATH).toBeUndefined();
});

test('pinned selection comes only from pinned env, preserving mixed-case Path', () => {
  const pinned = { CORTEX_GIT_BASH_PATH: 'D:/trial/Git/bin/bash.exe', Path: 'D:/trial/node;D:/trial/Git/cmd' };
  const env = launch(undefined, pinned);
  expect(env.CLAUDE_CODE_GIT_BASH_PATH).toBe(pinned.CORTEX_GIT_BASH_PATH);
  expect(env.Path).toBe(pinned.Path);
  expect(env.PATH).toBeUndefined();
  expect(pinned).not.toHaveProperty('CLAUDE_CODE_GIT_BASH_PATH');
});

test.each(['linux', 'darwin'])('%s keeps existing sanitization and PATH behavior', (os) => {
  Object.defineProperty(process, 'platform', { ...platform, value: os });
  vi.stubEnv('CLAUDE_CODE_GIT_BASH_PATH', '/unrelated/bash');
  const env = launch();
  expect(env.CLAUDE_CODE_GIT_BASH_PATH).toBeUndefined();
  expect(env.PATH).toBe(selectedPath);
});

test('missing native selection does not invent a Claude shell', () => {
  vi.stubEnv('CORTEX_GIT_BASH_PATH', undefined);
  expect(launch().CLAUDE_CODE_GIT_BASH_PATH).toBeUndefined();
});
