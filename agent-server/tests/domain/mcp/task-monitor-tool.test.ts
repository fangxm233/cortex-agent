// input:  registerTaskMonitorTools from domain/mcp/tools/task-monitor
// output: task_status / task_result / task_list handlers read TASKS.yaml correctly
// pos:    behavioral guard for the read-only task monitoring MCP tools
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import '../../_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROJECTS_DIR } from '../../../src/core/paths.js';
import { registerTaskMonitorTools } from '../../../src/domain/mcp/tools/task-monitor.js';

const projectDirs: string[] = [];
let seq = 0;

afterAll(() => { for (const d of projectDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

function makeProject(name: string, yaml: string): void {
  const dir = path.join(PROJECTS_DIR, name);
  projectDirs.push(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'TASKS.yaml'), yaml);
}

function captureHandlers(): Record<string, (input: any) => Promise<any>> {
  const handlers: Record<string, any> = {};
  const fakeServer: any = { tool: (name: string, _d: string, _s: any, _m: any, fn: any) => { handlers[name] = fn; } };
  registerTaskMonitorTools(fakeServer);
  return handlers;
}

function parse(res: any): any { return JSON.parse(res.content[0].text); }

const TASKS = (proj: string) => `tasks:
  - id: "aa01"
    text: parent task
    why: w
    done-when: dw
    priority: high
    status: open
    template: coder-review
    plan: ""
  - id: "bb01"
    text: done child
    why: w
    done-when: "child criteria"
    priority: medium
    status: done
    template: coder-review
    plan: ""
    parent: "aa01"
    completed-note: "produced X"
  - id: "cc01"
    text: blocked child
    why: w
    done-when: dw
    priority: low
    status: open
    template: coder-review
    plan: ""
    parent: "aa01"
    blocked-by: "stuck on dep"
`;

test('task_status returns lifecycle state for a task', async () => {
  const proj = `_tm_${seq++}`;
  makeProject(proj, TASKS(proj));
  const h = captureHandlers();
  const res = await h.task_status({ task_id: 'cc01', project: proj });
  const p = parse(res);
  assert.equal(p.id, 'cc01');
  assert.equal(p.status, 'open');
  assert.equal(p.blocked_by, 'stuck on dep');
  assert.equal(p.parent, 'aa01');
  assert.equal(p.actionable, false, 'a blocked task is not actionable');
});

test('task_status errors on unknown task', async () => {
  const proj = `_tm_${seq++}`;
  makeProject(proj, TASKS(proj));
  const h = captureHandlers();
  const res = await h.task_status({ task_id: 'zzzz', project: proj });
  assert.equal(res.isError, true);
});

test('task_result reports terminal done state with completion note', async () => {
  const proj = `_tm_${seq++}`;
  makeProject(proj, TASKS(proj));
  const h = captureHandlers();
  const res = await h.task_result({ task_id: 'bb01', project: proj });
  const p = parse(res);
  assert.equal(p.terminal, true);
  assert.equal(p.status, 'done');
  assert.equal(p.completed_note, 'produced X');
});

test('task_result flags a non-terminal task as partial', async () => {
  const proj = `_tm_${seq++}`;
  makeProject(proj, TASKS(proj));
  const h = captureHandlers();
  const res = await h.task_result({ task_id: 'aa01', project: proj });
  const p = parse(res);
  assert.equal(p.terminal, false);
  assert.match(p.note, /partial/);
});

test('task_list filters children by parent', async () => {
  const proj = `_tm_${seq++}`;
  makeProject(proj, TASKS(proj));
  const h = captureHandlers();
  const res = await h.task_list({ project: proj, parent: 'aa01' });
  const p = parse(res);
  const ids = p.tasks.map((t: any) => t.id).sort();
  assert.deepEqual(ids, ['bb01', 'cc01']);
});
