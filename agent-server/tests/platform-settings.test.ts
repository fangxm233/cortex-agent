// input:  isolated dotenv files, platform settings and skill scope
// output: platform persistence, redaction and gating regressions
// pos:    Platform configuration security and behavior tests
// >>> Once updated, update this header and parent CORTEX.md <<<

import { test, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { readPlatformSettings, writePlatformSettings } from '../src/domain/ui-service/platform-settings.js';
import { platformSettingsInput } from '../src/core/platform-settings-spec.js';
import { upsertEnvVar } from '../src/entry/feishu-login.js';
import { filterScopedPlugins } from '../src/domain/agents/spawn-config.js';
import { redactMutationAuditArgs } from '../src/domain/ui-service/ui-service.js';

async function fixture(run: (file: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'platform-settings-'));
  try { await run(path.join(dir, '.env')); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test('patch preserves unrelated configuration, replaces duplicate/export fields and never returns secrets', async () => {
  await fixture(async file => {
    await fs.writeFile(file, '# keep\nCORTEX_PLATFORM=slack,test\nexport FEISHU_APP_SECRET=old\nFEISHU_APP_SECRET=duplicate\nOTHER="two\nFEISHU_APP_SECRET=inside-other-value\nlines"\n');
    await writePlatformSettings(file, { platform: 'feishu', enabled: true, fields: {
      FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'private-secret', FEISHU_DOMAIN: 'lark',
    } });
    const env = parse(await fs.readFile(file, 'utf8'));
    expect(env.CORTEX_PLATFORM).toBe('slack,test,feishu');
    expect(env.FEISHU_APP_SECRET).toBe('private-secret');
    expect(env.OTHER).toBe('two\nFEISHU_APP_SECRET=inside-other-value\nlines');
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    const view = await readPlatformSettings(file, {});
    expect(JSON.stringify(view)).not.toContain('private-secret');
    expect(view[0]).toMatchObject({ platform: 'feishu', enabled: true, missing: [], pendingRestart: true });
  });
});

test('omitted secrets are retained; explicit null clears; disabled platforms retain credentials', async () => {
  await fixture(async file => {
    await writePlatformSettings(file, { platform: 'feishu', enabled: true, fields: { FEISHU_APP_SECRET: 'secret' } });
    await writePlatformSettings(file, { platform: 'feishu', enabled: false, fields: {} });
    expect(parse(await fs.readFile(file, 'utf8')).FEISHU_APP_SECRET).toBe('secret');
    await writePlatformSettings(file, { platform: 'slack', enabled: false, fields: {} });
    expect(parse(await fs.readFile(file, 'utf8')).CORTEX_PLATFORM).toBe('none');
    await writePlatformSettings(file, { platform: 'feishu', fields: { FEISHU_APP_SECRET: null } });
    expect(parse(await fs.readFile(file, 'utf8')).FEISHU_APP_SECRET).toBe('');
  });
});

test('shares the CLI mutation lock and survives concurrent platform edits', async () => {
  await fixture(async file => {
    await Promise.all([
      writePlatformSettings(file, { platform: 'feishu', enabled: true, fields: { FEISHU_APP_ID: 'cli_test' } }),
      writePlatformSettings(file, { platform: 'slack', enabled: true, fields: { SLACK_BOT_TOKEN: 'xoxb-test' } }),
      upsertEnvVar(file, 'FEISHU_AUTH_MODE', 'user'),
    ]);
    expect(parse(await fs.readFile(file, 'utf8'))).toMatchObject({
      FEISHU_AUTH_MODE: 'user', FEISHU_APP_ID: 'cli_test', SLACK_BOT_TOKEN: 'xoxb-test',
    });
  });
});

test('rejects foreign keys, wrong platform fields, invalid domain and dotenv injection without leaking values', () => {
  for (const fields of [
    { EVIL: 'value' }, { SLACK_BOT_TOKEN: 'private' }, { FEISHU_DOMAIN: 'evil' },
    { FEISHU_APP_SECRET: 'private\nEVIL=value' }, { FEISHU_APP_SECRET: "private'quote" },
    { FEISHU_APP_SECRET: '' },
  ]) expect(platformSettingsInput.safeParse({ platform: 'feishu', fields }).success).toBe(false);
  expect(redactMutationAuditArgs('config.setPlatform', { platform: 'feishu', fields: { FEISHU_APP_SECRET: 'private' } }))
    .toEqual({ redacted: true });
});

test('reports file/runtime differences without claiming connectivity or revealing inherited secrets', async () => {
  await fixture(async file => {
    await fs.writeFile(file, 'CORTEX_PLATFORM=feishu\nFEISHU_APP_ID=cli_test\nFEISHU_APP_SECRET=saved\n');
    const live = { CORTEX_PLATFORM: 'feishu', FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'inherited' };
    const [view] = await readPlatformSettings(file, live);
    expect(view.pendingRestart).toBe(true);
    expect(view.fields.find(f => f.key === 'FEISHU_APP_SECRET')).toMatchObject({ present: true, runtimePresent: true, differs: true });
    expect(JSON.stringify(view)).not.toMatch(/inherited|saved|connected/);
    expect((await readPlatformSettings(file, { ...live, FEISHU_APP_SECRET: 'saved' }))[0].pendingRestart).toBe(false);
  });
});

test('web skills are opt-in and never widen Slack/CLI or commission scope', () => {
  const dirs = ['/plugins/cortex-feishu/', '/plugins/cortex-system', '/plugins/cortex-commission'];
  expect(filterScopedPlugins(dirs, { channel: 'web:session' })).toEqual([dirs[1]]);
  expect(filterScopedPlugins(dirs, { channel: 'web:session', feishuSkillsInWeb: true })).toEqual(dirs.slice(0, 2));
  for (const channel of ['slack:C1', 'cli:local', '', undefined]) {
    expect(filterScopedPlugins(dirs, { channel, feishuSkillsInWeb: true })).toEqual([dirs[1]]);
  }
  expect(filterScopedPlugins(dirs, { channel: 'feishu:oc_1', feishuSkillsInWeb: false })).toEqual(dirs.slice(0, 2));
});
