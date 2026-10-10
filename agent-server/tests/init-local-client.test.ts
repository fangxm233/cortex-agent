import { expect, test } from 'vitest';
import { parseInitAnswersJson, generateDotEnvContent, getResolvedPaths, writeInitConfigs } from '../src/entry/init.js';
import { loadRuntimeDotenv } from '../src/core/runtime-env.js';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('local client enrollment is explicit and independent of local UI', () => {
  expect(parseInitAnswersJson('{}').localClient).toBeUndefined();
  expect(parseInitAnswersJson('{"localUi":{"enabled":true}}').localClient).toBeUndefined();
  expect(parseInitAnswersJson('{"localClient":{"enabled":false}}').localClient).toEqual({ enabled: false });
  expect(parseInitAnswersJson('{"localClient":{"enabled":true}}').localClient).toEqual({ enabled: true });
});
test.each([undefined, '127.0.0.1'])('client listener intent %j persists through normal dotenv reload', clientListenHost => {
  const answers = parseInitAnswersJson(JSON.stringify({ gpuCount: 0, clientListenHost, localClient: { enabled: true } }));
  expect(answers.clientListenHost).toBe(clientListenHost);
  const paths = getResolvedPaths(mkdtempSync(join(tmpdir(), 'client-host-')));
  mkdirSync(paths.CONFIG_DIR, { recursive: true });
  mkdirSync(paths.STORE_DIR, { recursive: true });
  writeInitConfigs(paths, answers, false);
  const envPath = join(paths.CONFIG_DIR, '.env');
  const cold: NodeJS.ProcessEnv = {};
  loadRuntimeDotenv(envPath, cold);
  expect(cold.CORTEX_CLIENT_HOST).toBe(clientListenHost);
  expect(cold.CORTEX_CLIENT_TOKEN).toMatch(/^[0-9a-f]{64}$/);
  const original = readFileSync(envPath, 'utf8');
  writeInitConfigs(paths, answers, true);
  expect(readFileSync(envPath, 'utf8')).toBe(original);
  const recovery: NodeJS.ProcessEnv = {};
  loadRuntimeDotenv(envPath, recovery);
  expect(recovery).toEqual(cold);
});

test.each([undefined, '0.0.0.0', '192.0.2.10'])('local App intent preserves existing env/token/registry with host %s even under force', host => {
  const paths = getResolvedPaths(mkdtempSync(join(tmpdir(), 'client-host-preserve-')));
  mkdirSync(paths.CONFIG_DIR, { recursive: true });
  mkdirSync(paths.STORE_DIR, { recursive: true });
  const original = `CORTEX_CLIENT_TOKEN=existing-test-token\n${host ? `CORTEX_CLIENT_HOST=${host}\n` : ''}`;
  const envPath = join(paths.CONFIG_DIR, '.env');
  const machinesPath = join(paths.CONFIG_DIR, 'machines.json');
  writeFileSync(envPath, original);
  writeFileSync(machinesPath, '{"existing":{"gpuCount":2}}\n');
  const answers = parseInitAnswersJson('{"gpuCount":0,"clientListenHost":"127.0.0.1","localClient":{"enabled":true}}');
  writeInitConfigs(paths, answers, true);
  expect(readFileSync(envPath, 'utf8')).toBe(original);
  expect(readFileSync(machinesPath, 'utf8')).toBe('{"existing":{"gpuCount":2}}\n');
});

test('ordinary and remote init omit client listener host unless explicitly requested', () => {
  for (const input of [{}, { localUi: { enabled: true } }, { localClient: { enabled: false } }]) {
    const answers = parseInitAnswersJson(JSON.stringify({ gpuCount: 0, ...input }));
    expect(answers.clientListenHost).toBeUndefined();
    expect(generateDotEnvContent(answers)).not.toContain('CORTEX_CLIENT_HOST');
  }
});

test.each([null, true, 127, [], {}, 'localhost', '0.0.0.0', '::1', '', ' 127.0.0.1', '127.0.0.1\nCORTEX_CLIENT_TOKEN=injected'].map(clientListenHost => ({ clientListenHost })))('reject invalid clientListenHost $clientListenHost', ({ clientListenHost }) => {
  expect(() => parseInitAnswersJson(JSON.stringify({ gpuCount: 0, clientListenHost }))).toThrow(/clientListenHost/);
});

test.each([null, true, [], {}, { enabled: 'true' }, { enabled: 1 }])('reject malformed localClient %j', (localClient) => {
  expect(() => parseInitAnswersJson(JSON.stringify({ localClient }))).toThrow(/localClient/);
});
