// input:  isolated UI service, authenticated HTTP transport and settings
// output: real config roundtrip, audit and HTTP redaction regressions
// pos:    Platform settings API integration boundary
// >>> Once updated, update this header and parent CORTEX.md <<<

import { test, expect } from 'vitest';
import { once } from 'node:events';
import { createUiService } from '../src/domain/ui-service/ui-service.js';
import { createAppRouter } from '../src/domain/ui-service/app-router.js';
import { createUiHttpServer } from '../src/platform/ui-http/ui-http-server.js';
import type { UiServiceDeps } from '../src/domain/ui-service/types.js';
import { buildAgentSpawnConfig } from '../src/domain/agents/spawn-config.js';
import { getSettings, updateSettings } from '../src/core/settings.js';
import { sanitizePluginEntry } from '../src/domain/ui-service/plugins-shared.js';

test('authenticated API saves credentials, reads redacted status and keeps secrets out of audit/errors', async () => {
  const events: unknown[] = [];
  const service = createUiService({ bus: { publish: (event: unknown) => events.push(event) } } as unknown as UiServiceDeps);
  const host = createUiHttpServer({ router: createAppRouter(service), getToken: () => 'test-only-token', port: 0, portForward: false });
  if (!host.server.listening) await once(host.server, 'listening');
  const address = host.server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}/trpc/`;
  const post = (op: string, input: unknown, token = 'test-only-token') => fetch(base + op, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-cortex-token': token }, body: JSON.stringify(input),
  });
  try {
    const patch = { platform: 'feishu', enabled: true, fields: { FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'integration-private' } };
    expect((await post('config.setPlatform', patch, 'wrong')).status).toBe(401);
    const saved = await post('config.setPlatform', patch);
    expect(saved.status).toBe(200);
    expect(await saved.text()).not.toContain('integration-private');
    const snapshot = await fetch(base + 'config.get?input=%7B%7D', { headers: { 'x-cortex-token': 'test-only-token' } });
    const text = await snapshot.text();
    expect(text).toContain('cli_test');
    expect(text).not.toContain('integration-private');
    const invalid = await post('config.setPlatform', { ...patch, fields: { 'integration-private': 'also-private' } });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toMatch(/integration-private|also-private/);
    expect(JSON.stringify(events)).not.toContain('integration-private');
    const runtime = await post('config.set', { section: 'settings', value: { feishuSkillsInWeb: true, feishuAdminChannel: 'oc_test' } });
    expect(runtime.status).toBe(200);
    expect(getSettings()).toMatchObject({ feishuSkillsInWeb: true, feishuAdminChannel: 'oc_test' });
  } finally { await host.close(); }
});

test('spawn consumes the persisted setting and catalog advertises the same scope', async () => {
  await updateSettings({ feishuSkillsInWeb: true });
  const spawn = buildAgentSpawnConfig(
    { loadCortexRules: false, cwd: '/tmp', channel: 'web:test', pluginDirs: ['/plugins/cortex-feishu'] },
    { model: 'test', backend: 'claude', mode: null },
    {},
  );
  expect(spawn.pluginDirs).toContain('/plugins/cortex-feishu');
  const entry = sanitizePluginEntry({ id: 'cortex-feishu', skills: [], mcp: { status: 'absent', servers: [] }, issues: [], manifest: {} } as any);
  expect(entry.scopePrefix).toBe('feishu: / web:');
});
