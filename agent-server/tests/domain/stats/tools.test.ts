import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { classifyTool, parseToolLine } from '../../../src/domain/stats/tool-calls.js';
import { ToolActivityIndex, scanFileRange, type ToolCell } from '../../../src/domain/stats/tool-index.js';
import { aggregateTools } from '../../../src/domain/stats/tools.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-04T05:42:00Z');

beforeAll(() => { process.env.TZ = 'America/Denver'; });

function toolLine(toolName: string, at: number, fullInput: unknown = {}): string {
  return JSON.stringify({ type: 'tool', toolName, toolInput: '', ts: new Date(at).toISOString(), toolUseId: 'x', fullInput }) + '\n';
}

describe('classifyTool', () => {
  it('counts skills by name, MCP calls by server, and merges built-in spellings', () => {
    expect(classifyTool('Skill', { skill: 'cortex-coder:develop' })).toEqual({ kind: 'skill', name: 'cortex-coder:develop' });
    expect(classifyTool('Skill', undefined, '{"skill":"dataviz"}')).toEqual({ kind: 'skill', name: 'dataviz' });
    expect(classifyTool('Skill', undefined, '{"skill":"trunc')).toEqual({ kind: 'skill', name: 'unknown' });
    expect(classifyTool('mcp__cortex-core__remote_bash')).toEqual({ kind: 'mcp', name: 'cortex-core' });
    expect(classifyTool('mcp__odd')).toEqual({ kind: 'mcp', name: 'mcp__odd' });
    expect(classifyTool('bash')).toEqual({ kind: 'tool', name: 'Bash' });
    expect(classifyTool('Bash')).toEqual({ kind: 'tool', name: 'Bash' });
  });

  it('parses only tool lines with a name and a time', () => {
    expect(parseToolLine(toolLine('Read', NOW).trim())).toEqual({ kind: 'tool', name: 'Read', hour: Math.floor(NOW / HOUR) });
    expect(parseToolLine('{"type":"tool-images","ts":"2026-11-04T05:00:00Z"}')).toBeNull();
    expect(parseToolLine('{"type":"tool","toolName":"Read"}')).toBeNull();
    expect(parseToolLine('{"type":"tool",broken')).toBeNull();
    expect(parseToolLine('{"type":"assistant","text":"hi"}')).toBeNull();
  });
});

describe('scanFileRange', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stats-scan-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('reads tool lines across chunk boundaries and skips huge other lines', async () => {
    const file = path.join(dir, 's.jsonl');
    const huge = JSON.stringify({ type: 'assistant', text: 'x'.repeat(2_500_000) }) + '\n';
    const lines = [toolLine('Bash', NOW), huge, ...Array.from({ length: 30_000 }, () => toolLine('Read', NOW, { file_path: '/a/b/c' }))];
    await fs.writeFile(file, lines.join(''));
    const size = (await fs.stat(file)).size;
    const names: string[] = [];
    const end = await scanFileRange(file, 0, size, (call) => names.push(call.name));
    expect(end).toBe(size);
    expect(names.length).toBe(30_001);
    expect(names[0]).toBe('Bash');
  });

  it('stops before a line still being written', async () => {
    const file = path.join(dir, 's.jsonl');
    const done = toolLine('Bash', NOW);
    await fs.writeFile(file, done + toolLine('Read', NOW).slice(0, 20));
    const names: string[] = [];
    const end = await scanFileRange(file, 0, (await fs.stat(file)).size, (call) => names.push(call.name));
    expect(names).toEqual(['Bash']);
    expect(end).toBe(Buffer.byteLength(done));
  });
});

describe('ToolActivityIndex', () => {
  let dir: string;
  let history: string;
  let indexPath: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stats-index-'));
    history = path.join(dir, 'history');
    indexPath = path.join(dir, 'data', 'tool-activity.json');
    await fs.mkdir(history);
  });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  const counts = (cells: readonly ToolCell[]) => Object.fromEntries(
    [...cells].sort((a, b) => (a.sessionId + a.name).localeCompare(b.sessionId + b.name)).map((c) => [`${c.sessionId}:${c.name}`, c.count]));

  it('builds in the background, then reads only appended bytes', async () => {
    await fs.writeFile(path.join(history, 'a.jsonl'), toolLine('Bash', NOW) + toolLine('bash', NOW));
    const index = new ToolActivityIndex({ historyDir: history, indexPath, now: () => NOW });
    expect((await index.snapshot()).ready).toBe(false);
    await index.refresh();
    expect(counts((await index.snapshot()).cells)).toEqual({ 'a:Bash': 2 });
    await fs.appendFile(path.join(history, 'a.jsonl'), toolLine('Read', NOW) + '{"type":"tool","toolName":"Gr');
    await index.refresh();
    expect(counts((await index.snapshot()).cells)).toEqual({ 'a:Bash': 2, 'a:Read': 1 });
    await fs.appendFile(path.join(history, 'a.jsonl'), 'ep","ts":"2026-11-04T05:00:00Z"}\n');
    await index.refresh();
    expect(counts((await index.snapshot()).cells)).toEqual({ 'a:Bash': 2, 'a:Read': 1, 'a:Grep': 1 });
  });

  it('rescans a file that shrank or was replaced, and forgets deleted files', async () => {
    const a = path.join(history, 'a.jsonl');
    await fs.writeFile(a, toolLine('Bash', NOW).repeat(3));
    await fs.writeFile(path.join(history, 'b.jsonl'), toolLine('Edit', NOW));
    const index = new ToolActivityIndex({ historyDir: history, indexPath, now: () => NOW });
    await index.refresh();
    await fs.writeFile(a, toolLine('Bash', NOW));
    await index.refresh();
    expect(counts((await index.snapshot()).cells)).toEqual({ 'a:Bash': 1, 'b:Edit': 1 });
    const replacement = path.join(dir, 'tmp.jsonl');
    await fs.writeFile(replacement, toolLine('Write', NOW).repeat(4));
    await fs.rename(replacement, a);
    await fs.rm(path.join(history, 'b.jsonl'));
    await index.refresh();
    expect(counts((await index.snapshot()).cells)).toEqual({ 'a:Write': 4 });
  });

  it('persists progress so a restart is ready at once and resumes from the offsets', async () => {
    const a = path.join(history, 'a.jsonl');
    await fs.writeFile(a, toolLine('Bash', NOW));
    const first = new ToolActivityIndex({ historyDir: history, indexPath, now: () => NOW });
    await first.refresh();
    await fs.appendFile(a, toolLine('Bash', NOW));
    const second = new ToolActivityIndex({ historyDir: history, indexPath, now: () => NOW });
    const snapshot = await second.snapshot();
    expect(snapshot.ready).toBe(true);
    expect(counts(snapshot.cells)).toEqual({ 'a:Bash': 1 });
    await second.refresh();
    expect(counts((await second.snapshot()).cells)).toEqual({ 'a:Bash': 2 });
  });

  it('skips files untouched for 90 days and prunes counts past the retention', async () => {
    const old = path.join(history, 'old.jsonl');
    await fs.writeFile(old, toolLine('Bash', NOW - 100 * DAY));
    const stale = new Date(NOW - 95 * DAY);
    await fs.utimes(old, stale, stale);
    await fs.writeFile(path.join(history, 'mixed.jsonl'), toolLine('Bash', NOW - 91 * DAY) + toolLine('Read', NOW - DAY));
    let now = NOW;
    const index = new ToolActivityIndex({ historyDir: history, indexPath, now: () => now });
    await index.refresh();
    expect(counts((await index.snapshot()).cells)).toEqual({ 'mixed:Read': 1 });
    now = NOW + 90 * DAY;
    await index.refresh();
    expect((await index.snapshot()).cells).toEqual([]);
  });

  it('refreshes at most once per interval', async () => {
    await fs.writeFile(path.join(history, 'a.jsonl'), toolLine('Bash', NOW));
    let now = NOW;
    const index = new ToolActivityIndex({ historyDir: history, indexPath, now: () => now });
    await index.refresh();
    await fs.appendFile(path.join(history, 'a.jsonl'), toolLine('Bash', NOW));
    now += 10_000;
    await index.snapshot();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(counts((await index.snapshot()).cells)).toEqual({ 'a:Bash': 1 });
    now += 60_000;
    await index.snapshot();
    await index.refresh();
    expect(counts((await index.snapshot()).cells)).toEqual({ 'a:Bash': 2 });
  });
});

describe('aggregateTools', () => {
  const hour = (at: number) => Math.floor(at / HOUR);
  const cells: ToolCell[] = [
    { sessionId: 's1', hour: hour(NOW - HOUR), kind: 'tool', name: 'Bash', count: 50 },
    { sessionId: 's2', hour: hour(NOW - HOUR), kind: 'tool', name: 'bash', count: 5 },
    { sessionId: 's2', hour: hour(NOW - 2 * HOUR), kind: 'tool', name: 'Read', count: 10 },
    { sessionId: 's1', hour: hour(NOW - 40 * DAY), kind: 'tool', name: 'Grep', count: 100 },
    { sessionId: 's1', hour: hour(NOW - HOUR), kind: 'skill', name: 'dataviz', count: 3 },
    ...Array.from({ length: 12 }, (_, i) => ({ sessionId: 's3', hour: hour(NOW - HOUR), kind: 'tool' as const, name: `T${i}`, count: 1 })),
  ];
  const projectOf = (sessionId: string) => (sessionId === 's2' ? 'p2' : 'general');
  const query = { range: '30d' as const, page: 0, projectId: null, kind: 'tool' as const };

  it('is empty, not zero, until the index is ready', () => {
    const tools = aggregateTools({ ready: false, cells }, query, NOW, projectOf);
    expect(tools).toMatchObject({ ready: false, total: 0, distinct: 0, series: [], ranking: [] });
    expect(tools.window.range).toBe('30d');
  });

  it('merges spellings, ranks top 10 and charts top 5', () => {
    const tools = aggregateTools({ ready: true, cells }, query, NOW, projectOf);
    expect(tools.total).toBe(50 + 5 + 10 + 12);
    expect(tools.distinct).toBe(14);
    expect(tools.ranking[0]).toEqual({ name: 'Bash', count: 55, colorSlot: 1 });
    expect(tools.ranking[1]).toEqual({ name: 'Read', count: 10, colorSlot: 2 });
    expect(tools.ranking).toHaveLength(10);
    expect(tools.series).toHaveLength(5);
    expect(tools.series[0]).toMatchObject({ key: 'Bash', folded: 0, total: 55 });
    expect(tools.series[0]!.values).toHaveLength(30);
  });

  it('filters by project and kind with colour slots fixed by the 90-day rank', () => {
    const tools = aggregateTools({ ready: true, cells }, { ...query, projectId: 'p2' }, NOW, projectOf);
    expect(tools.ranking).toEqual([{ name: 'Read', count: 10, colorSlot: 2 }, { name: 'Bash', count: 5, colorSlot: 1 }]);
    const skills = aggregateTools({ ready: true, cells }, { ...query, kind: 'skill' }, NOW, projectOf);
    expect(skills.ranking).toEqual([{ name: 'dataviz', count: 3, colorSlot: 0 }]);
  });
});
