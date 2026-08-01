// input:  temporary roots and literal C2/C3 records
// output: hand-built journal fixture trees
// pos:    Portable fixtures for trajectory merge tests
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT_RUN_ID = 'run-001';
const MODEL_HASH = '1'.repeat(64);
const BUNDLE_HASH = '3'.repeat(64);
const HASH_KEYS = {
  canonical_instruction_sha256: 'a'.repeat(64),
  model_visible_prompt_sha256: 'b'.repeat(64),
  system_prompt_sha256: 'c'.repeat(64),
  tool_manifest_sha256: 'd'.repeat(64),
  plugin_manifest_sha256: 'e'.repeat(64),
};

export interface FixtureJournal {
  threadId: string | null;
  journalPath: string;
  startedPath: string;
  terminalPath: string;
  events: Array<Record<string, unknown>>;
}

export interface MergeFixture {
  root: string;
  parent: FixtureJournal;
  children: FixtureJournal[];
  sourceEvents: Array<Record<string, unknown>>;
}

interface EventSpec {
  ts: string;
  step: number | null;
  agentSlot: 'parent' | 'benchmark-coder' | 'benchmark-reviewer';
  reportedModel?: string | null;
  event: Record<string, unknown>;
}

interface JournalSpec {
  threadId: string | null;
  agentSlot: 'parent' | 'benchmark-coder';
  roleHash: string;
  events: EventSpec[];
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function journalName(threadId: string | null): string {
  return threadId === null ? `run-${ROOT_RUN_ID}.ndjson` : `thread-${threadId}.ndjson`;
}

function lifecycleName(threadId: string | null, suffix: string): string {
  const prefix = threadId === null ? `run-${ROOT_RUN_ID}` : `thread-${threadId}`;
  return `${prefix}.${suffix}.json`;
}

function header(spec: JournalSpec, root: string): Record<string, unknown> {
  return {
    schema_version: 'cortex-bench-journal/1',
    type: 'run_header',
    root_run_id: ROOT_RUN_ID,
    thread_id: spec.threadId,
    agent_slot: spec.agentSlot,
    seq: 0,
    ts: '2026-08-01T00:00:00.000Z',
    resolved_cwd: path.join(root, 'workspace'),
    ...HASH_KEYS,
    model_execution_identity_hash: MODEL_HASH,
    role_tool_surface_hash: spec.roleHash,
    bundle_manifest_hash: BUNDLE_HASH,
  };
}

function eventRecord(spec: JournalSpec, event: EventSpec, seq: number): Record<string, unknown> {
  return {
    schema_version: 'cortex-bench-journal/1',
    type: 'event',
    root_run_id: ROOT_RUN_ID,
    thread_id: spec.threadId,
    step: event.step,
    agent_slot: event.agentSlot,
    seq,
    ts: event.ts,
    backend: 'claude',
    provider: 'anthropic',
    requested_model: 'claude-sonnet-4-5',
    reported_model: event.reportedModel === undefined
      ? 'claude-sonnet-4-5-20250929' : event.reportedModel,
    model_execution_identity_hash: MODEL_HASH,
    role_tool_surface_hash: spec.roleHash,
    bundle_manifest_hash: BUNDLE_HASH,
    event: event.event,
  };
}

function terminalRecord(
  journalPath: string,
  journalBytes: string,
  spec: JournalSpec,
): Record<string, unknown> {
  return {
    schema_version: 'cortex-bench-manifest/1',
    state: 'completed',
    started_at: '2026-08-01T00:00:00.000Z',
    ended_at: '2026-08-01T00:00:10.000Z',
    journal_path: journalPath,
    journal_sha256: sha256(journalBytes),
    event_count: spec.events.length,
    supervisor: { quiescent: true, descendants: 0 },
    steps: spec.events.length,
    cost_usd: null,
    tokens: { input: null, output: null },
    model_execution_identity_hash: MODEL_HASH,
    role_tool_surface_hash: spec.roleHash,
    bundle_manifest_hash: BUNDLE_HASH,
    terminal_reason: 'ok',
  };
}

function writeJournal(root: string, spec: JournalSpec): FixtureJournal {
  const journalPath = path.join(root, journalName(spec.threadId));
  const records = [header(spec, root), ...spec.events.map((item, index) => (
    eventRecord(spec, item, index + 1)
  ))];
  const journalBytes = `${records.map(record => JSON.stringify(record)).join('\n')}\n`;
  fs.writeFileSync(journalPath, journalBytes);
  const startedPath = path.join(root, lifecycleName(spec.threadId, 'started'));
  fs.writeFileSync(startedPath, `${JSON.stringify({
    root_run_id: ROOT_RUN_ID,
    thread_id: spec.threadId,
    ts: '2026-08-01T00:00:00.000Z',
    journal_path: journalPath,
  })}\n`);
  const terminalPath = path.join(root, lifecycleName(spec.threadId, 'terminal'));
  fs.writeFileSync(terminalPath, `${JSON.stringify(terminalRecord(journalPath, journalBytes, spec))}\n`);
  return { threadId: spec.threadId, journalPath, startedPath, terminalPath, events: records.slice(1) };
}

function mcpResult(threadId: string): string {
  return JSON.stringify({
    content: [{ type: 'text', text: JSON.stringify({ thread_id: threadId, status: 'completed' }) }],
  });
}

function parentEvents(): EventSpec[] {
  return [
    { ts: '2026-08-01T00:00:01.000Z', step: null, agentSlot: 'parent', event: { type: 'assistant_text', text: 'parent starts' } },
    { ts: '2026-08-01T00:00:04.000Z', step: null, agentSlot: 'parent', event: { type: 'tool_use', toolUseId: 'call-b', name: 'mcp__cortex-benchmark-thread__thread_run', input: { handoff: 'child b' } } },
    { ts: '2026-08-01T00:00:08.000Z', step: null, agentSlot: 'parent', event: { type: 'tool_result', toolUseId: 'call-b', ok: true, content: mcpResult('thread-b') } },
    { ts: '2026-08-01T00:00:05.000Z', step: null, agentSlot: 'parent', event: { type: 'tool_use', toolUseId: 'call-a', name: 'mcp__cortex-benchmark-thread__thread_run', input: { handoff: 'child a' } } },
    { ts: '2026-08-01T00:00:09.000Z', step: null, agentSlot: 'parent', event: { type: 'tool_result', toolUseId: 'call-a', ok: true, content: mcpResult('thread-a') } },
    { ts: '2026-08-01T00:00:10.000Z', step: null, agentSlot: 'parent', event: { type: 'assistant_text', text: 'parent ends' } },
  ];
}

function childEvents(label: string, offset: number): EventSpec[] {
  return [
    { ts: `2026-08-01T00:00:0${offset}.000Z`, step: 1, agentSlot: 'benchmark-coder', event: { type: 'assistant_text', text: `${label} codes` } },
    { ts: `2026-08-01T00:00:0${offset + 1}.000Z`, step: 2, agentSlot: 'benchmark-reviewer', event: { type: 'assistant_text', text: `${label} reviews` } },
  ];
}

function ordinaryParentEvents(): EventSpec[] {
  return [
    { ts: '2026-08-01T00:00:01.000Z', step: null, agentSlot: 'parent', reportedModel: null, event: { type: 'assistant_text', text: 'working alone' } },
    { ts: '2026-08-01T00:00:02.000Z', step: null, agentSlot: 'parent', event: { type: 'tool_use', toolUseId: 'bash-1', name: 'Bash', input: { command: 'true' } } },
    { ts: '2026-08-01T00:00:03.000Z', step: null, agentSlot: 'parent', event: { type: 'tool_result', toolUseId: 'bash-1', ok: true, content: 'ok' } },
  ];
}

function sourceEvents(parent: FixtureJournal, children: FixtureJournal[]): Array<Record<string, unknown>> {
  return [parent, ...children].flatMap(item => item.events);
}

export function writeTreeFixture(root: string): MergeFixture {
  fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
  const parent = writeJournal(root, {
    threadId: null, agentSlot: 'parent', roleHash: '2'.repeat(64), events: parentEvents(),
  });
  const children = [
    writeJournal(root, {
      threadId: 'thread-a', agentSlot: 'benchmark-coder', roleHash: '4'.repeat(64),
      events: childEvents('child a', 3),
    }),
    writeJournal(root, {
      threadId: 'thread-b', agentSlot: 'benchmark-coder', roleHash: '5'.repeat(64),
      events: childEvents('child b', 2),
    }),
  ];
  return { root, parent, children, sourceEvents: sourceEvents(parent, children) };
}

export function writeParentOnlyFixture(root: string): MergeFixture {
  fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
  const parent = writeJournal(root, {
    threadId: null, agentSlot: 'parent', roleHash: '2'.repeat(64), events: ordinaryParentEvents(),
  });
  return { root, parent, children: [], sourceEvents: parent.events };
}

function readRecords(journal: FixtureJournal): Array<Record<string, any>> {
  return fs.readFileSync(journal.journalPath, 'utf8').trimEnd().split('\n')
    .map(line => JSON.parse(line));
}

function writeRecords(journal: FixtureJournal, records: Array<Record<string, any>>): void {
  const bytes = `${records.map(record => JSON.stringify(record)).join('\n')}\n`;
  fs.writeFileSync(journal.journalPath, bytes);
  const terminal = JSON.parse(fs.readFileSync(journal.terminalPath, 'utf8'));
  terminal.journal_sha256 = sha256(bytes);
  terminal.event_count = records.length - 1;
  fs.writeFileSync(journal.terminalPath, `${JSON.stringify(terminal)}\n`);
  journal.events = records.slice(1);
}

export function driftModelIdentity(child: FixtureJournal): void {
  const records = readRecords(child);
  for (const record of records) record.model_execution_identity_hash = '9'.repeat(64);
  writeRecords(child, records);
  const terminal = JSON.parse(fs.readFileSync(child.terminalPath, 'utf8'));
  terminal.model_execution_identity_hash = '9'.repeat(64);
  fs.writeFileSync(child.terminalPath, `${JSON.stringify(terminal)}\n`);
}

export function setThreadResultContent(
  journal: FixtureJournal, callId: string, content: string,
): void {
  const records = readRecords(journal);
  const record = records.find(item => item.event?.type === 'tool_result'
    && item.event.toolUseId === callId);
  record.event.content = content;
  writeRecords(journal, records);
}

export function setToolName(journal: FixtureJournal, callId: string, name: string): void {
  const records = readRecords(journal);
  const record = records.find(item => item.event?.type === 'tool_use'
    && item.event.toolUseId === callId);
  record.event.name = name;
  writeRecords(journal, records);
}

export function removeFragment(journal: FixtureJournal): void {
  fs.unlinkSync(journal.startedPath);
  fs.unlinkSync(journal.terminalPath);
  fs.unlinkSync(journal.journalPath);
}

const TERMINAL_REASONS = {
  completed: 'ok', failed: 'child_failure', cancelled: 'cancelled', timeout: 'deadline',
} as const;

export function setTerminalState(
  journal: FixtureJournal, state: keyof typeof TERMINAL_REASONS,
): void {
  const terminal = JSON.parse(fs.readFileSync(journal.terminalPath, 'utf8'));
  terminal.state = state;
  terminal.terminal_reason = TERMINAL_REASONS[state];
  fs.writeFileSync(journal.terminalPath, `${JSON.stringify(terminal)}\n`);
}

export function setSupervisor(
  journal: FixtureJournal, quiescent: boolean, descendants: number,
): void {
  const terminal = JSON.parse(fs.readFileSync(journal.terminalPath, 'utf8'));
  terminal.supervisor = { quiescent, descendants };
  fs.writeFileSync(journal.terminalPath, `${JSON.stringify(terminal)}\n`);
}

export function truncateTerminalJournal(journal: FixtureJournal): void {
  const records = readRecords(journal);
  records.pop();
  writeRecords(journal, records);
  setTerminalState(journal, 'timeout');
}

export function makeZeroEventTerminal(journal: FixtureJournal): void {
  const records = readRecords(journal);
  writeRecords(journal, records.slice(0, 1));
  setTerminalState(journal, 'timeout');
}
