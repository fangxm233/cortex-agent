import { afterEach, expect, test, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('@core/log.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

import { removeConnectionBy, upsertConnectionFrom } from '../../../src/domain/connections/editor.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

function editor() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-connection-editor-'));
  dirs.push(dir);
  return { file: path.join(dir, 'connections.json'), onChanged: vi.fn() };
}

function stored(file: string, backend: string, id: string): Record<string, any> | undefined {
  const { connections } = JSON.parse(fs.readFileSync(file, 'utf8'));
  return connections.find((entry: { backend: string; id: string }) => entry.backend === backend && entry.id === id);
}

const KEY = 'sk-sentinel-0000-1111';
const RELAY = { kind: 'claude' as const, id: 'relay', baseUrl: 'https://relay.example', key: KEY };
const CUSTOM = { kind: 'pi-custom' as const, provider: 'vllm', api: 'openai-completions' as const, baseUrl: 'http://box:8000/v1', models: ['m1'] };

test('a Claude connection is created with defaults and edited without resending its key', () => {
  const deps = editor();
  const created = upsertConnectionFrom({ ...RELAY, create: true }, deps);
  expect(created).toMatchObject({ ok: true, connection: { id: 'relay', kind: 'key', label: 'relay', billing: 'metered', models: null } });
  expect(JSON.stringify(created)).not.toContain(KEY);
  expect(stored(deps.file, 'claude', 'relay')).toMatchObject({ authStyle: 'x-api-key', key: KEY });

  upsertConnectionFrom({ kind: 'claude', id: 'relay', label: 'Relay', models: ['qwen'], authStyle: 'bearer' }, deps);
  expect(stored(deps.file, 'claude', 'relay')).toMatchObject({
    label: 'Relay', baseUrl: 'https://relay.example', key: KEY, models: ['qwen'], authStyle: 'bearer',
  });
  expect(deps.onChanged).toHaveBeenCalledWith('claude');
});

test('clearing the base URL and the models returns a Claude connection to Anthropic\'s API and catalog', () => {
  const deps = editor();
  upsertConnectionFrom({ ...RELAY, models: ['qwen'] }, deps);
  upsertConnectionFrom({ kind: 'claude', id: 'relay', baseUrl: '', models: [] }, deps);
  const saved = stored(deps.file, 'claude', 'relay')!;
  expect(saved.baseUrl).toBeUndefined();
  expect(saved.models).toBeUndefined();
});

test('a Claude connection needs a key, a free name that is not the subscription\'s, and an http(s) URL', () => {
  const deps = editor();
  expect(upsertConnectionFrom({ kind: 'claude', id: 'relay' }, deps)).toEqual({ ok: false, errors: ['key-required'] });
  expect(upsertConnectionFrom({ ...RELAY, id: 'subscription' }, deps)).toEqual({ ok: false, errors: ['name-reserved'] });
  expect(upsertConnectionFrom({ ...RELAY, id: 'has space' }, deps)).toEqual({ ok: false, errors: ['name-charset'] });
  expect(upsertConnectionFrom({ ...RELAY, baseUrl: 'ftp://x' }, deps)).toEqual({ ok: false, errors: ['upstream-scheme'] });
  upsertConnectionFrom(RELAY, deps);
  expect(upsertConnectionFrom({ ...RELAY, create: true }, deps)).toEqual({ ok: false, errors: ['name-taken'] });
  expect(upsertConnectionFrom({ ...RELAY, key: '' }, deps)).toEqual({ ok: false, errors: ['key-required'] });
});

test('a PI override keeps its key when the edit omits it and drops it when the edit clears it', () => {
  const deps = editor();
  upsertConnectionFrom({ kind: 'pi-override', provider: 'openai', baseUrl: 'https://proxy.example/v1', key: KEY }, deps);
  upsertConnectionFrom({ kind: 'pi-override', provider: 'openai', baseUrl: 'https://proxy2.example/v1' }, deps);
  expect(stored(deps.file, 'pi', 'openai')).toMatchObject({ baseUrl: 'https://proxy2.example/v1', key: KEY });
  upsertConnectionFrom({ kind: 'pi-override', provider: 'openai', baseUrl: 'https://proxy2.example/v1', key: '' }, deps);
  expect(stored(deps.file, 'pi', 'openai')?.key).toBeUndefined();
  expect(upsertConnectionFrom({ kind: 'pi-override', provider: 'openai', baseUrl: '' }, deps))
    .toEqual({ ok: false, errors: ['upstream-required'] });
  expect(deps.onChanged).toHaveBeenCalledWith('pi');
});

test('an override and a custom provider cannot share a name', () => {
  const deps = editor();
  upsertConnectionFrom(CUSTOM, deps);
  expect(upsertConnectionFrom({ kind: 'pi-override', provider: 'vllm', baseUrl: 'https://x.example' }, deps))
    .toEqual({ ok: false, errors: ['name-taken'] });
  upsertConnectionFrom({ kind: 'pi-override', provider: 'openai', baseUrl: 'https://x.example' }, deps);
  expect(upsertConnectionFrom({ ...CUSTOM, provider: 'openai' }, deps)).toEqual({ ok: false, errors: ['name-taken'] });
  expect(upsertConnectionFrom({ ...CUSTOM, create: true }, deps)).toEqual({ ok: false, errors: ['name-taken'] });
});

test('a custom provider is saved as a PI connection carrying its definition', () => {
  const deps = editor();
  const result = upsertConnectionFrom({ ...CUSTOM, key: KEY, create: true }, deps);
  expect(result).toMatchObject({ ok: true, connection: { id: 'vllm', kind: 'custom', api: 'openai-completions', models: ['m1'] } });
  expect(stored(deps.file, 'pi', 'vllm')).toMatchObject({ baseUrl: 'http://box:8000/v1', key: KEY });
  expect(deps.onChanged).toHaveBeenCalledWith('pi');
});

test('remove deletes any stored kind and reports one that is not there', async () => {
  const deps = editor();
  upsertConnectionFrom(RELAY, deps);
  upsertConnectionFrom(CUSTOM, deps);
  upsertConnectionFrom({ kind: 'pi-override', provider: 'openai', baseUrl: 'https://x.example' }, deps);
  for (const ref of [{ backend: 'claude' as const, id: 'relay' }, { backend: 'pi' as const, id: 'vllm' }, { backend: 'pi' as const, id: 'openai' }]) {
    expect(await removeConnectionBy(ref, deps)).toEqual({ ok: true, connection: null });
    expect(stored(deps.file, ref.backend, ref.id)).toBeUndefined();
  }
  expect(await removeConnectionBy({ backend: 'claude', id: 'subscription' }, deps)).toEqual({ ok: false, errors: ['not-found'] });
});
