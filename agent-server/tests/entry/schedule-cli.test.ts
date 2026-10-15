import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runScheduleCli } from '../../src/entry/schedule-cli.js';
import { runCli } from '../../src/entry/cli.js';
import { Scheduler } from '../../src/domain/scheduling/scheduler.js';
import { ScheduleRepo } from '../../src/store/schedule-repo.js';
import { getDefaultSelection, resolveModelRef, selectionForModel } from '../../src/domain/agents/models.js';
import { rememberModelSelection } from '../../src/domain/agents/config.js';
import { DEFAULT_SELECTION, OTHER_SELECTION, seedScheduleModels } from '../domain/scheduling/selection-fixture.js';

let tmpDir: string;
beforeAll(() => {
  seedScheduleModels();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-cli-'));
});
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

let fileIdx = 0;
function setup(tasks: object[] = []) {
  const file = path.join(tmpDir, `schedules-${fileIdx++}.json`);
  fs.writeFileSync(file, JSON.stringify({ tasks }));
  const repo = new ScheduleRepo(file);
  const cli = async (...args: string[]) => {
    const result = await runScheduleCli(args, { repo, readStdin: () => 'from stdin\n' });
    return { ...result, json: result.exitCode === 0 ? JSON.parse(result.stdout) : null };
  };
  return { file, repo, cli, onDisk: () => JSON.parse(fs.readFileSync(file, 'utf8')).tasks };
}

const DAILY = { id: 'daily1', type: 'daily', time: '09:00', message: 'digest', projectId: 'p1', selection: DEFAULT_SELECTION, createdAt: 1, nextRun: 2 };
const ONCE = { id: 'once1', type: 'once', runAt: Date.now() + 60_000, message: 'later', projectId: 'p2', selection: DEFAULT_SELECTION, createdAt: 1 };

test('add creates each kind from flags and prints it with ISO timestamps', async () => {
  const { cli, onDisk } = setup();
  const interval = await cli('add', '--type', 'interval', '--interval', '30m', '--message', 'check GPU', '--project', 'nimbus');
  assert.equal(interval.exitCode, 0, interval.stderr);
  assert.equal(interval.json.ok, true);
  assert.equal(interval.json.created, true);
  assert.equal(interval.json.schedule.intervalMs, 1_800_000);
  assert.equal(interval.json.schedule.projectId, 'nimbus');
  assert.deepEqual(interval.json.schedule.selection, getDefaultSelection());
  assert.match(interval.json.schedule.nextRun, /^\d{4}-\d{2}-\d{2}T/);

  const weekly = await cli('add', '--type', 'weekly', '--day', 'mon', '--time', '21:00', '--message', 'review');
  assert.equal(weekly.json.schedule.dayOfWeek, 1);
  assert.equal(weekly.json.schedule.projectId, 'general');

  const once = await cli('add', '--type', 'once', '--delay', '2h', '--message', '-');
  assert.equal(once.json.schedule.message, 'from stdin');
  assert.equal(onDisk().length, 3);
});

test('add rejects bad input with the valid values and writes nothing', async () => {
  const { cli, onDisk } = setup();
  const cases: Array<[string[], RegExp]> = [
    [['add', '--interval', '30m', '--message', 'm'], /Missing --type[\s\S]*interval, daily, weekly, once/],
    [['add', '--type', 'hourly', '--message', 'm'], /invalid type: 'hourly'/],
    [['add', '--type', 'interval', '--interval', '30m', '--message', '   '], /message must be a non-empty prompt/],
    [['add', '--type', 'interval', '--interval', '30', '--message', 'm'], /invalid interval: '30'/],
    [['add', '--type', 'daily', '--time', '09:00', '--interval', '1h', '--message', 'm'], /--interval does not apply to --type daily[\s\S]*--time/],
    [['add', '--type', 'daily', '--time', '09:00', '--message', 'm', '--channel', 'C1'], /Unknown option for 'add': '--channel'/],
    [['add', 'interval', '30m', 'positional message'], /Unexpected argument: 'interval'/],
  ];
  for (const [args, pattern] of cases) {
    const result = await cli(...args);
    assert.equal(result.exitCode, 1, args.join(' '));
    assert.match(result.stderr, pattern);
  }
  assert.equal(onDisk().length, 0);
});

test('add with an idempotency key returns the first schedule on retry', async () => {
  const { cli, onDisk } = setup();
  const args = ['add', '--type', 'daily', '--time', '08:00', '--message', 'standup', '--idempotency-key', 'k1'];
  const first = await cli(...args);
  const retry = await cli(...args);
  assert.equal(first.json.created, true);
  assert.equal(retry.json.created, false);
  assert.equal(retry.json.schedule.id, first.json.schedule.id);
  assert.equal(onDisk().length, 1);
});

test('list filters by project; get reports a missing id with a fix path', async () => {
  const { cli } = setup([DAILY, ONCE]);
  const list = await cli('list', '--project', 'p1');
  assert.deepEqual(list.json.schedules.map((s: { id: string }) => s.id), ['daily1']);
  assert.equal(list.json.count, 1);
  assert.equal((await cli('get', 'once1')).json.schedule.message, 'later');

  const missing = await cli('get', 'nope');
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr, /Schedule not found: 'nope'[\s\S]*cortex schedule list/);
});

test('edit changes fields of the schedule type and rejects foreign ones', async () => {
  const { cli } = setup([DAILY, ONCE]);
  const edited = await cli('edit', 'daily1', '--time', '10:30', '--message', 'evening digest');
  assert.equal(edited.json.schedule.time, '10:30');
  assert.equal(edited.json.schedule.message, 'evening digest');

  const moved = await cli('edit', 'once1', '--delay', '3h');
  assert.ok(Date.parse(moved.json.schedule.runAt) > Date.now() + 2.9 * 3_600_000);

  const foreign = await cli('edit', 'daily1', '--interval', '1h');
  assert.equal(foreign.exitCode, 1);
  assert.match(foreign.stderr, /invalid fields for daily: intervalMs/);
  assert.match((await cli('edit', 'daily1')).stderr, /nothing to update/);
  assert.match((await cli('edit', 'daily1', '--type', 'once')).stderr, /Unknown option for 'edit': '--type'/);
});

test('pause and resume are state transitions; remove is retry-safe and previews with --dry-run', async () => {
  const { cli, onDisk } = setup([DAILY]);
  assert.equal((await cli('pause', 'daily1')).json.schedule.isPaused, true);
  assert.equal((await cli('pause', 'daily1')).json.schedule.isPaused, true);
  const resumed = await cli('resume', 'daily1');
  assert.equal(resumed.json.schedule.isPaused, false);
  assert.match(resumed.json.schedule.nextRun, /T/);

  const preview = await cli('remove', 'daily1', '--dry-run');
  assert.deepEqual([preview.json.dry_run, preview.json.would_remove.id], [true, 'daily1']);
  assert.equal(onDisk().length, 1);
  assert.deepEqual((await cli('remove', 'daily1')).json, { ok: true, id: 'daily1', removed: true });
  assert.deepEqual((await cli('remove', 'daily1')).json, { ok: true, id: 'daily1', removed: false });
});

test('a CLI add reaches a running daemon and survives the daemon\'s next write', async () => {
  const { file, cli, onDisk } = setup([{ ...DAILY, type: 'interval', intervalMs: 3_600_000, nextRun: Date.now() + 3_600_000 }]);
  const daemon = new Scheduler(async () => {}, {}, { schedulesFile: file, watchFile: false });
  try {
    await daemon.start();
    const added = await cli('add', '--type', 'interval', '--interval', '1h', '--message', 'from the cli');
    await daemon.update('daily1', { message: 'daemon edit' });
    assert.deepEqual(onDisk().map((t: { id: string }) => t.id).sort(), [added.json.schedule.id, 'daily1'].sort());

    await daemon._hotReload();
    assert.ok(daemon.timers.has(added.json.schedule.id));
  } finally {
    daemon.stop();
  }
});

test('model flags persist a concrete selection with memory and validated thinking', async () => {
  const { cli, onDisk } = setup();
  rememberModelSelection(OTHER_SELECTION);
  const args = ['add', '--type', 'daily', '--time', '09:00', '--message', 'm'];
  const remembered = await cli(...args, '--model', 'openai/gpt-test');
  assert.equal(remembered.exitCode, 0, remembered.stderr);
  assert.deepEqual(remembered.json.schedule.selection, selectionForModel(resolveModelRef('openai/gpt-test')));
  const explicit = await cli(...args, '--model', 'openai/gpt-test', '--thinking', 'high');
  assert.deepEqual(explicit.json.schedule.selection, { ...OTHER_SELECTION, thinking: 'high' });
  const bare = await cli(...args, '--model', DEFAULT_SELECTION.model);
  assert.equal(bare.exitCode, 0, bare.stderr);
  assert.equal(bare.json.schedule.selection.backend, 'claude');
  assert.equal(bare.json.schedule.selection.model, DEFAULT_SELECTION.model);
  assert.equal(onDisk().length, 3);
});

test('thinking without a model on add uses a concrete copy of the default', async () => {
  const { cli } = setup();
  const result = await cli('add', '--type', 'daily', '--time', '09:00', '--message', 'm', '--thinking', 'low');
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(result.json.schedule.selection, { ...getDefaultSelection(), thinking: 'low' });
});

test('thinking-only edits preserve the scheduled model instead of taking the current default', async () => {
  const { cli } = setup([{ ...DAILY, selection: OTHER_SELECTION }]);
  const result = await cli('edit', 'daily1', '--thinking', 'low');
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(result.json.schedule.selection, { ...OTHER_SELECTION, thinking: 'low' });
  const modelEdit = await cli('edit', 'daily1', '--model', DEFAULT_SELECTION.model, '--thinking', 'high');
  assert.equal(modelEdit.exitCode, 0, modelEdit.stderr);
  assert.deepEqual(modelEdit.json.schedule.selection, DEFAULT_SELECTION);
});

test('model flag errors reject writes, including retired flags and backend-specific thinking', async () => {
  const { cli, onDisk } = setup();
  const args = ['add', '--type', 'daily', '--time', '09:00', '--message', 'm'];
  for (const flags of [['--profile', 'plan'], ['--model'], ['--model', '--thinking', 'low'], ['--thinking', 'bogus'], ['--thinking', 'minimal']]) {
    const result = await cli(...args, ...flags);
    assert.equal(result.exitCode, 1, flags.join(' '));
  }
  assert.match((await cli(...args, '--thinking', 'bogus')).stderr, /Valid values:/);
  assert.equal(onDisk().length, 0);
});

test('cortex schedule is wired into the main CLI with help and subcommand errors', async () => {
  const help = await runCli(['schedule', '--help']);
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /cortex schedule add --type interval/);
  assert.match(help.stdout, /--model \[provider\/\]model/);
  assert.match(help.stdout, /--thinking/);
  assert.doesNotMatch(help.stdout, /--profile/);
  assert.match((await runCli(['--help'])).stdout, /schedule/);

  const unknown = await runCli(['schedule', 'set']);
  assert.equal(unknown.exitCode, 1);
  assert.match(unknown.stderr, /Unknown subcommand: 'set'[\s\S]*list, get, add, edit, pause, resume, remove/);
});
