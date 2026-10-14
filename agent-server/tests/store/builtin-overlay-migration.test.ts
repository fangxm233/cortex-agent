import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULTS_DIR } from '../../src/core/paths.js';
import { migrateToBuiltinOverlay } from '../../src/store/builtin-overlay-migration.js';
import { environmentPluginDirs, listBuiltinPluginIds } from '../../src/domain/plugins/builtin.js';

const NOW = new Date('2026-10-13T08:00:00.000Z');
const ARCHIVE = path.join('config', 'archive', 'builtin-overlay-20261013T080000Z');
const BUILTINS = listBuiltinPluginIds(path.join(DEFAULTS_DIR, 'plugins'));

let home: string;

function write(rel: string, content: string): void {
  const target = path.join(home, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function shipped(rel: string): string {
  return fs.readFileSync(path.join(DEFAULTS_DIR, rel), 'utf8');
}

function has(rel: string): boolean {
  return fs.existsSync(path.join(home, rel));
}

function read(rel: string): string {
  return fs.readFileSync(path.join(home, rel), 'utf8');
}

function json(rel: string): Record<string, unknown> {
  return JSON.parse(read(rel));
}

/** Copy a shipped tree into the home the way the old plugin sync deployed it. */
function deploy(fromRel: string, toRel: string): void {
  fs.cpSync(path.join(DEFAULTS_DIR, fromRel), path.join(home, toRel), { recursive: true });
}

function env(name: string, body: Record<string, unknown>): void {
  write(path.join('config', 'environments', `${name}.json`), `${JSON.stringify({ name, profile: '__active__', ...body }, null, 2)}\n`);
}

function versioned(script: string): string {
  return script.replace('\n', '\n// @cortex-hook-version 2026.10.6\n');
}

function withVersion(rel: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ ...JSON.parse(shipped(rel)), version: '2026.7.29', ...extra }, null, 2)}\n`;
}

/** A home as the copy model left it: deployed plugin and hook copies, copy-once rules, roles and
 *  prompts, and environments that list the built-in plugins they load. */
function seedLegacyHome(): void {
  deploy(path.join('plugins', 'cortex-system'), path.join('plugins', 'cortex-system'));
  deploy(path.join('plugins', 'cortex-feishu'), path.join('plugins', 'cortex-feishu'));
  for (const id of ['cortex-system', 'cortex-feishu']) {
    write(path.join('plugins', id, '.claude-plugin', 'plugin.json'), `{ "name": "${id}", "version": "0.1.0" }\n`);
  }
  write('plugins/cortex-system/plugin.json', '{ "name": "cortex-system", "version": "0.0.1" }\n');
  write('plugins/cortex-system/skills/schedule/SKILL.md', '---\nname: schedule\ndescription: older text\n---\n');
  write('plugins/cortex-system/skills/task/SKILL.md', '---\nname: task\ndescription: retired\n---\n');
  write('plugins/cortex-system/skills/project-init/notes.md', 'a note left in a shipped skill\n');
  write('plugins/cortex-system/skills/experiment-notes/SKILL.md', '---\nname: experiment-notes\ndescription: mine\n---\n');
  write('plugins/cortex-system/skills/experiment-notes/references/a.md', 'reference\n');
  write('plugins/my-pack/plugin.json', '{ "name": "my-pack" }\n');

  write('hooks/rules-loader.mjs', versioned(shipped('hooks/rules-loader.mjs')));
  write('hooks/status-md-guard.mjs', `${shipped('hooks/status-md-guard.mjs')}\n// local tweak\n`);
  write('hooks/AGENTS.md', '# my hooks\n');
  write('hooks/my-hook.mjs', 'console.log("mine");\n');
  write('config/hooks/06-rules-loader.json', withVersion('config/hooks/06-rules-loader.json'));
  write('config/hooks/13-status-md-guard.json', withVersion('config/hooks/13-status-md-guard.json', { enabled: false }));
  write('config/hooks/05-memory-ref-tracker.json', withVersion('config/hooks/05-memory-ref-tracker.json', { matcher: 'Read' }));
  write('config/hooks/99-mine.json', '{ "id": "mine", "event": "agent:post-tool", "run": { "script": "my-hook.mjs" } }\n');

  write('rules/agents-md.md', shipped('rules/agents-md.md'));
  write('rules/status-md.md', `${shipped('rules/status-md.md')}\nLocal addition.\n`);
  write('rules/my-rule.md', 'mine\n');
  write('config/agents/plan.md', shipped('agents/plan.md'));
  write('config/agents/explore.md', `${shipped('agents/explore.md')}\nLocal addition.\n`);
  write('prompts/systemPrompts/direct.md', shipped('prompts/systemPrompts/direct.md'));
  write('prompts/systemPrompts/web.md', 'my web prompt\n');
  write('prompts/directives/coder.md', 'my directive\n');

  env('main', { pluginDirs: ['plugins/cortex-system', 'plugins/cortex-board', 'plugins/cortex-feishu', 'plugins/my-pack'] });
  env('worker', { pluginDirs: ['plugins/cortex-system'] });
  env('bare', { pluginDirs: [] });
  env('creative', { skills: false, pluginDirs: [] });
  env('settled', { disabledPlugins: ['cortex-feishu'] });
}

/** What an environment loaded under the copy model (exactly its list), and loads now. */
function loadedBefore(body: Record<string, unknown>): string[] {
  return ((body.pluginDirs as string[] | undefined) ?? []).map((dir) => path.resolve(home, dir)).sort();
}

function loadedAfter(body: Record<string, unknown>): string[] {
  return (environmentPluginDirs(body, { dataDir: home, builtinIds: BUILTINS }) ?? []).sort();
}

function environments(): Record<string, Record<string, unknown>> {
  const dir = path.join(home, 'config', 'environments');
  return Object.fromEntries(fs.readdirSync(dir).map((file) => [file, JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))]));
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'builtin-overlay-home-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('moving an upgraded home to built-ins read in place', () => {
  it('keeps every environment loading the same plugins', async () => {
    seedLegacyHome();
    const before = environments();

    await migrateToBuiltinOverlay({ dataDir: home, defaultsDir: DEFAULTS_DIR, now: NOW });
    const after = environments();

    for (const file of Object.keys(before)) {
      const was = before[file].skills === false || 'disabledPlugins' in before[file]
        ? loadedAfter(before[file]) : loadedBefore(before[file]);
      expect(loadedAfter(after[file]), file).toEqual(was);
    }
    expect(after['main.json']).toMatchObject({ pluginDirs: ['plugins/my-pack'], disabledPlugins: [] });
    expect(after['worker.json'].pluginDirs).toBeUndefined();
    expect(after['worker.json'].disabledPlugins).toEqual(['cortex-board', 'cortex-feishu']);
    expect(after['bare.json'].disabledPlugins).toEqual(BUILTINS);
    expect(after['creative.json']).toEqual(before['creative.json']);
    expect(after['settled.json']).toEqual(before['settled.json']);
  });

  it('leaves only the user content of the built-in plugins, archiving what differs', async () => {
    seedLegacyHome();
    await migrateToBuiltinOverlay({ dataDir: home, defaultsDir: DEFAULTS_DIR, now: NOW });

    expect(has('plugins/cortex-feishu')).toBe(false);
    expect(has('plugins/my-pack/plugin.json')).toBe(true);
    const system = path.join(home, 'plugins', 'cortex-system');
    expect(fs.readdirSync(system)).toEqual(['skills']);
    expect(fs.readdirSync(path.join(system, 'skills'))).toEqual(['experiment-notes']);
    expect(has('plugins/cortex-system/skills/experiment-notes/references/a.md')).toBe(true);
    for (const rel of [
      'plugins/cortex-system/plugin.json',
      'plugins/cortex-system/.claude-plugin/plugin.json',
      'plugins/cortex-feishu/.claude-plugin/plugin.json',
      'plugins/cortex-system/skills/schedule/SKILL.md',
      'plugins/cortex-system/skills/task/SKILL.md',
      'plugins/cortex-system/skills/project-init/notes.md',
    ]) {
      expect(fs.existsSync(path.join(home, ARCHIVE, rel)), rel).toBe(true);
    }
    expect(fs.existsSync(path.join(home, ARCHIVE, 'plugins/cortex-system/skills/approval'))).toBe(false);
  });

  it('removes deployed hooks, keeping the user scripts and a switched-off registration', async () => {
    seedLegacyHome();
    await migrateToBuiltinOverlay({ dataDir: home, defaultsDir: DEFAULTS_DIR, now: NOW });

    expect(fs.readdirSync(path.join(home, 'hooks')).sort()).toEqual(['AGENTS.md', 'my-hook.mjs']);
    expect(fs.existsSync(path.join(home, ARCHIVE, 'hooks/status-md-guard.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(home, ARCHIVE, 'hooks/rules-loader.mjs'))).toBe(false);
    expect(fs.readdirSync(path.join(home, 'config', 'hooks')).sort()).toEqual(['13-status-md-guard.json', '99-mine.json']);
    expect(json('config/hooks/13-status-md-guard.json')).toEqual({ enabled: false });
    expect(fs.existsSync(path.join(home, ARCHIVE, 'config/hooks/05-memory-ref-tracker.json'))).toBe(true);
  });

  it('drops unchanged copies of rules, roles and prompts and keeps the edited ones', async () => {
    seedLegacyHome();
    await migrateToBuiltinOverlay({ dataDir: home, defaultsDir: DEFAULTS_DIR, now: NOW });

    expect(fs.readdirSync(path.join(home, 'rules')).sort()).toEqual(['my-rule.md', 'status-md.md']);
    expect(fs.readdirSync(path.join(home, 'config', 'agents'))).toEqual(['explore.md']);
    expect(fs.readdirSync(path.join(home, 'prompts', 'systemPrompts'))).toEqual(['web.md']);
    expect(read('prompts/directives/coder.md')).toBe('my directive\n');
  });

  it('changes nothing when run again', async () => {
    seedLegacyHome();
    await migrateToBuiltinOverlay({ dataDir: home, defaultsDir: DEFAULTS_DIR, now: NOW });
    const settled = environments();

    const again = await migrateToBuiltinOverlay({ dataDir: home, defaultsDir: DEFAULTS_DIR, now: new Date('2026-10-14T00:00:00Z') });

    expect(again).toEqual({ removed: [], archived: [], environments: [] });
    expect(environments()).toEqual(settled);
  });

  it('leaves a fresh home, which never had the copies, as it is', async () => {
    env('main', { tools: 'Read' });
    write('config/hooks/99-mine.json', '{ "enabled": false }\n');

    const report = await migrateToBuiltinOverlay({ dataDir: home, defaultsDir: DEFAULTS_DIR, now: NOW });

    expect(report).toEqual({ removed: [], archived: [], environments: [] });
    expect(json('config/environments/main.json')).toEqual({ name: 'main', profile: '__active__', tools: 'Read' });
  });
});
