import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  connectionForLegacyMode, maskKey, parseConnections, readConnections, removeConnection,
  upsertConnection, writeConnections, type StoredConnection,
} from '../../src/core/connections-file.js';

const RELAY: StoredConnection = {
  id: 'relay', backend: 'claude', label: 'Relay', baseUrl: 'https://relay.example.com', authStyle: 'bearer',
  key: 'fake-relay-key-0001', billing: 'metered',
};
const DEEPSEEK: StoredConnection = {
  id: 'deepseek', backend: 'pi', provider: 'deepseek', baseUrl: 'https://deepseek-relay.example.com', key: 'fake-ds-key',
};
let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connections-file-'));
  file = path.join(dir, 'config', 'connections.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('connections file', () => {
  it('reads a missing or corrupt file as no connections', () => {
    expect(readConnections(file)).toEqual([]);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json');
    expect(readConnections(file)).toEqual([]);
  });

  it('round-trips entries owner-only, in order', () => {
    writeConnections([RELAY, DEEPSEEK], file);
    expect(readConnections(file)).toEqual([RELAY, DEEPSEEK]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).version).toBe(1);
  });

  it('upserts in place by backend and id, and removes', () => {
    writeConnections([RELAY, DEEPSEEK], file);
    upsertConnection({ ...RELAY, label: 'Renamed' }, file);
    upsertConnection({ ...RELAY, id: 'deepseek', label: 'Claude deepseek' }, file);
    expect(readConnections(file).map((entry) => `${entry.backend}:${entry.id}`))
      .toEqual(['claude:relay', 'pi:deepseek', 'claude:deepseek']);
    expect(readConnections(file)[0]).toMatchObject({ label: 'Renamed' });
    expect(removeConnection({ backend: 'pi', id: 'deepseek' }, file)).toBe(true);
    expect(removeConnection({ backend: 'pi', id: 'deepseek' }, file)).toBe(false);
    expect(readConnections(file).map((entry) => entry.id)).toEqual(['relay', 'deepseek']);
  });
});

describe('parseConnections', () => {
  it('drops malformed, keyless, reserved and duplicate entries', () => {
    const parsed = parseConnections({ connections: [
      RELAY, { ...RELAY, label: 'duplicate' },
      { id: 'subscription', backend: 'claude', key: 'fake' },
      { id: 'no-key', backend: 'claude' },
      { id: 'bad id', backend: 'claude', key: 'fake' },
      { id: 'other', backend: 'codex', key: 'fake' },
      { id: 'no-url', backend: 'pi', provider: 'openai' },
      'not an object',
    ] });
    expect(parsed).toEqual([RELAY]);
  });

  it('defaults a Claude entry to x-api-key, metered, labelled by its id', () => {
    expect(parseConnections({ connections: [{ id: 'k', backend: 'claude', key: ' fake-key ' }] }))
      .toEqual([{ id: 'k', backend: 'claude', label: 'k', authStyle: 'x-api-key', key: 'fake-key', billing: 'metered' }]);
  });

  it('identifies a PI connection by its provider and keeps a custom definition', () => {
    const [override, custom] = parseConnections({ connections: [
      { id: 'anything', backend: 'pi', provider: 'openai', baseUrl: 'https://proxy.example.com/v1' },
      { id: 'local', backend: 'pi', api: 'openai-completions', baseUrl: 'http://127.0.0.1:8000/v1',
        models: [{ id: 'm1', contextWindow: 8192 }, { name: 'no id' }], headers: { 'x-a': '1', 'x-b': 2 } },
    ] });
    expect(override).toEqual({ id: 'openai', backend: 'pi', provider: 'openai', baseUrl: 'https://proxy.example.com/v1' });
    expect(custom).toEqual({ id: 'local', backend: 'pi', provider: 'local', api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:8000/v1', models: [{ id: 'm1', contextWindow: 8192 }], headers: { 'x-a': '1' } });
  });
});

describe('maskKey', () => {
  it('shows enough to recognise a key, never enough to use it', () => {
    expect(maskKey('sk-fake-0123456789abcd')).toBe('sk-…abcd');
    expect(maskKey('short-key')).toBe('••••');
    expect(maskKey(undefined)).toBeNull();
  });
});

describe('connectionForLegacyMode', () => {
  it('maps a gateway-era route name to the connection it stood for', () => {
    expect(connectionForLegacyMode('claude', 'plan')).toBe('subscription');
    expect(connectionForLegacyMode('claude', 'api')).toBe('api');
    expect(connectionForLegacyMode('claude', '')).toBeNull();
    expect(connectionForLegacyMode('pi', 'deepseek')).toBeNull();
  });
});
