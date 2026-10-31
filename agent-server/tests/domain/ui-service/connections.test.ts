import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, vi } from 'vitest';
import { EventBus } from '../../../src/events/event-bus.js';

import { handleConnectionsList } from '../../../src/domain/ui-service/query/connections.js';
import { handleConnectionsRemove, handleConnectionsUpsert } from '../../../src/domain/ui-service/mutate/connections.js';
import { createUiService, redactMutationAuditArgs } from '../../../src/domain/ui-service/ui-service.js';
import {
  connectionsListInput, connectionsRemoveInput, connectionsUpsertInput,
} from '../../../src/domain/ui-service/input-schemas.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';

const UPSTREAM_KEY = 'sentinel-upstream-key';

const CUSTOM = {
  kind: 'pi-custom' as const,
  provider: 'my-vllm',
  api: 'anthropic-messages' as const,
  baseUrl: 'http://127.0.0.1:8100',
  key: UPSTREAM_KEY,
  models: ['Model-27B'],
};

const RELAY = { kind: 'claude' as const, id: 'relay', baseUrl: 'https://relay.example/v1', key: UPSTREAM_KEY };

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-ui-connections-'));
  return path.join(dir, 'config', 'connections.json');
}

function stored(file: string, backend: string, id: string): Record<string, unknown> | undefined {
  const { connections } = JSON.parse(fs.readFileSync(file, 'utf8'));
  return connections.find((entry: { backend: string; id: string }) => entry.backend === backend && entry.id === id);
}

function depsWith(file: string, events: unknown[] = [], onChanged = vi.fn()): UiServiceDeps {
  return {
    connectionEditor: { file, onChanged },
    bus: Object.assign(new EventBus(), { publish: (event: unknown) => events.push(event) }),
  } as unknown as UiServiceDeps;
}

test('connections.list shows stored connections with a key hint, never the key', async () => {
  const file = tmpFile();
  const deps = depsWith(file);
  assert.equal((await handleConnectionsUpsert(deps, CUSTOM)).ok, true);
  assert.equal((await handleConnectionsUpsert(deps, RELAY)).ok, true);

  const listed = (await handleConnectionsList(deps, {})).filter((view) => view.kind !== 'subscription');
  const custom = listed.find((view) => view.id === 'my-vllm')!;
  assert.equal(custom.kind, 'custom');
  assert.equal(custom.api, 'anthropic-messages');
  assert.equal(custom.baseUrl, 'http://127.0.0.1:8100');
  assert.deepEqual(custom.models, ['Model-27B']);
  assert.ok(custom.keyHint);
  assert.equal(listed.find((view) => view.id === 'relay')?.kind, 'key');
  assert.ok(!JSON.stringify(listed).includes(UPSTREAM_KEY));
});

test('connections.upsert reports a rejected draft as invalid-args and writes nothing', async () => {
  const file = tmpFile();
  const result = await handleConnectionsUpsert(depsWith(file), { ...CUSTOM, baseUrl: 'ftp://box/api' });

  assert.equal(result.ok, false);
  assert.equal((result as { code: string }).code, 'invalid-args');
  assert.match((result as { message: string }).message, /http/i);
  assert.equal(fs.existsSync(file), false);
});

test('connections.upsert returns the saved view and tells the caches which backend changed', async () => {
  const onChanged = vi.fn();
  const result = await handleConnectionsUpsert(depsWith(tmpFile(), [], onChanged), RELAY);

  assert.equal(result.ok, true);
  const view = (result as { data: { connection: { id: string; keyHint: string } } }).data.connection;
  assert.equal(view.id, 'relay');
  assert.ok(!JSON.stringify(view).includes(UPSTREAM_KEY));
  assert.deepEqual(onChanged.mock.calls, [['claude']]);
});

test('connections.remove deletes the connection and reports a missing one', async () => {
  const file = tmpFile();
  const deps = depsWith(file);
  await handleConnectionsUpsert(deps, CUSTOM);

  const removed = await handleConnectionsRemove(deps, { backend: 'pi', id: 'my-vllm' });
  assert.deepEqual(removed, { ok: true, data: { removed: true } });
  assert.equal(stored(file, 'pi', 'my-vllm'), undefined);

  const missing = await handleConnectionsRemove(deps, { backend: 'pi', id: 'my-vllm' });
  assert.equal(missing.ok, false);
  assert.equal((missing as { code: string }).code, 'not-found');
});

test('the upsert audit event carries no key', async () => {
  const events: any[] = [];
  const service = createUiService(depsWith(tmpFile(), events));

  const result = await service.mutate('connections.upsert', CUSTOM);

  assert.equal(result.ok, true);
  const audit = events.find((event) => event.type === 'ui.mutate-invoked');
  assert.equal(audit.args.provider, 'my-vllm');
  assert.equal(audit.args.key, undefined);
  assert.ok(!JSON.stringify(events).includes(UPSTREAM_KEY));
  assert.deepEqual(redactMutationAuditArgs('connections.upsert', { id: 'x', key: UPSTREAM_KEY }), { id: 'x' });
});

test('connection input schemas gate the shape before the handler runs', () => {
  assert.equal(connectionsListInput.safeParse({}).success, true);
  assert.equal(connectionsRemoveInput.safeParse({ backend: 'pi', id: 'my vllm' }).success, false);
  assert.equal(connectionsRemoveInput.safeParse({ backend: 'claude', id: 'relay' }).success, true);
  assert.equal(connectionsUpsertInput.safeParse(CUSTOM).success, true);
  assert.equal(connectionsUpsertInput.safeParse(RELAY).success, true);
  assert.equal(connectionsUpsertInput.safeParse({ ...CUSTOM, api: 'ollama-native' }).success, false);
  assert.equal(connectionsUpsertInput.safeParse({ ...CUSTOM, models: [] }).success, false);
  assert.equal(connectionsUpsertInput.safeParse({ kind: 'pi-override', provider: 'openai' }).success, false);
  assert.equal(connectionsUpsertInput.safeParse({ ...RELAY, kind: 'other' }).success, false);
});
