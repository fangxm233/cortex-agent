// input:  accounted C2/C3 files, output path, filesystem
// output: exclusive ATIF metrics or typed fail-closed errors
// pos:    Parent-plus-child journal merge boundary
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateTrajectoryRoot } from './manifest.js';
import {
  buildAtifTree,
  type AtifFinalMetrics,
  type SourceFragment,
  type SourceJournalEvent,
  type SourceJournalHeader,
  type ThreadLink,
} from './atif.js';

export type TrajectoryMergeReason = 'started_without_terminal' | 'EACCES' | 'ENOSPC'
  | 'malformed_fragment' | 'identity_hash_drift' | 'unresolvable_subagent_link'
  | 'unbound_child_fragment' | 'missing_child_fragment' | 'ambiguous_subagent_link'
  | 'output_path_exists' | 'output_path_not_writable' | 'containment_failure'
  | 'aggregate_metrics_underivable';

export class TrajectoryMergeError extends Error {
  constructor(readonly reason: TrajectoryMergeReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TrajectoryMergeError';
  }
}

export interface TrajectoryMergeFileSystem {
  readdir(directory: string): string[];
  readFile(filePath: string): Buffer;
  exists(filePath: string): boolean;
  realpath(filePath: string): string;
  access(filePath: string, mode: number): void;
  open(filePath: string, flags: number, mode: number): number;
  write(fd: number, data: Buffer, offset: number, length?: number): number;
  fsync(fd: number): void;
  close(fd: number): void;
  link(source: string, destination: string): void;
  unlink(filePath: string): void;
}

export const NODE_TRAJECTORY_MERGE_FS: TrajectoryMergeFileSystem = {
  readdir: directory => fs.readdirSync(directory),
  readFile: filePath => fs.readFileSync(filePath),
  exists: filePath => fs.existsSync(filePath),
  realpath: filePath => fs.realpathSync(filePath),
  access: (filePath, mode) => fs.accessSync(filePath, mode),
  open: (filePath, flags, mode) => fs.openSync(filePath, flags, mode),
  write: (fd, data, offset, length = data.length - offset) => fs.writeSync(fd, data, offset, length),
  fsync: fd => fs.fsyncSync(fd),
  close: fd => fs.closeSync(fd),
  link: (source, destination) => fs.linkSync(source, destination),
  unlink: filePath => fs.unlinkSync(filePath),
};

export interface MergeTrajectoryOptions {
  trajectoryRoot: string;
  outputPath: string;
  subagentLinks?: ThreadLink[];
}

export interface FragmentOutcome {
  thread_id: string | null;
  state: unknown;
  terminal_reason: unknown;
}

export interface MergeTrajectoryResult {
  outputPath: string;
  sha256: string;
  trajectoryId: string;
  fragments: FragmentOutcome[];
}

interface LifecycleInput {
  markerPath: string;
  marker: Record<string, unknown>;
  markerBytes: Buffer;
  terminalPath: string;
  terminal: Record<string, unknown>;
  terminalBytes: Buffer;
  journalPath: string;
  journalBytes: Buffer;
}

function mergeError(reason: TrajectoryMergeReason, message: string, cause?: unknown): never {
  throw new TrajectoryMergeError(reason, message, cause === undefined ? undefined : { cause });
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeError(error: unknown): TrajectoryMergeError {
  if (error instanceof TrajectoryMergeError) return error;
  if (isErrno(error, 'EACCES')) return new TrajectoryMergeError('EACCES', 'Filesystem access denied', { cause: error });
  if (isErrno(error, 'ENOSPC')) return new TrajectoryMergeError('ENOSPC', 'Filesystem has no space', { cause: error });
  return new TrajectoryMergeError('malformed_fragment', errorMessage(error), { cause: error });
}

function parseObject(bytes: Buffer, context: string): Record<string, unknown> {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value;
  } catch (error) {
    mergeError('malformed_fragment', `${context} is not valid JSON`, error);
  }
  return mergeError('malformed_fragment', `${context} is not a JSON object`);
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function confinedJournalPath(
  root: string, journalPath: unknown, fileSystem: TrajectoryMergeFileSystem,
): string {
  if (typeof journalPath !== 'string') return mergeError('malformed_fragment', 'Missing journal path');
  const resolvedRoot = path.resolve(root);
  const resolvedJournal = path.resolve(root, journalPath);
  if (!isWithin(resolvedRoot, resolvedJournal)) return mergeError('malformed_fragment', 'Journal is outside root');
  const realRoot = fileSystem.realpath(resolvedRoot);
  const realJournal = fileSystem.realpath(resolvedJournal);
  if (!isWithin(realRoot, realJournal)) return mergeError('malformed_fragment', 'Journal resolves outside root');
  return realJournal;
}

function loadLifecycle(
  root: string, name: string, fileSystem: TrajectoryMergeFileSystem,
): LifecycleInput {
  const markerPath = path.join(root, name);
  const markerBytes = fileSystem.readFile(markerPath);
  const marker = parseObject(markerBytes, markerPath);
  const terminalPath = markerPath.replace(/\.started\.json$/, '.terminal.json');
  if (!fileSystem.exists(terminalPath)) {
    return mergeError('started_without_terminal', `Missing terminal manifest for ${name}`);
  }
  const terminalBytes = fileSystem.readFile(terminalPath);
  const terminal = parseObject(terminalBytes, terminalPath);
  const journalPath = confinedJournalPath(root, marker.journal_path, fileSystem);
  const journalBytes = fileSystem.readFile(journalPath);
  return {
    markerPath, marker, markerBytes, terminalPath, terminal, terminalBytes,
    journalPath, journalBytes,
  };
}

function loadInputs(root: string, fileSystem: TrajectoryMergeFileSystem): LifecycleInput[] {
  const names = fileSystem.readdir(root).filter(name => name.endsWith('.started.json')).sort();
  if (names.length === 0) return mergeError('malformed_fragment', 'No started markers found');
  return names.map(name => loadLifecycle(root, name, fileSystem));
}

function supervisorEvidence(terminal: Record<string, unknown>): Record<string, unknown> {
  const supervisor = terminal.supervisor;
  if (!supervisor || typeof supervisor !== 'object' || Array.isArray(supervisor)) {
    return mergeError('malformed_fragment', 'Terminal manifest has no supervisor evidence');
  }
  const evidence = supervisor as Record<string, unknown>;
  if (typeof evidence.quiescent !== 'boolean' || !Number.isInteger(evidence.descendants)) {
    return mergeError('malformed_fragment', 'Terminal supervisor evidence is unparseable');
  }
  return evidence;
}

function assertContainment(inputs: LifecycleInput[]): void {
  for (const input of inputs) {
    const evidence = supervisorEvidence(input.terminal);
    if (evidence.quiescent !== true || evidence.descendants !== 0) {
      mergeError('containment_failure', 'Terminal manifest is not quiescent');
    }
  }
}

function assertJournalLinkage(input: LifecycleInput): void {
  if (input.terminal.journal_path !== input.marker.journal_path) {
    mergeError('malformed_fragment', 'Lifecycle journal paths disagree');
  }
}

// Remap only journal_path; validate all other fields and exact journal bytes from one snapshot.
function writeValidationInput(root: string, input: LifecycleInput, index: number): void {
  assertJournalLinkage(input);
  const journalPath = path.join(root, `journal-${index}.ndjson`);
  fs.writeFileSync(journalPath, input.journalBytes);
  const marker = { ...input.marker, journal_path: journalPath };
  const terminal = { ...input.terminal, journal_path: journalPath };
  fs.writeFileSync(path.join(root, path.basename(input.markerPath)), `${JSON.stringify(marker)}\n`);
  fs.writeFileSync(path.join(root, path.basename(input.terminalPath)), `${JSON.stringify(terminal)}\n`);
}

function validateSnapshot(inputs: LifecycleInput[]): void {
  assertContainment(inputs);
  const validationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trajectory-merge-validate-'));
  try {
    inputs.forEach((input, index) => writeValidationInput(validationRoot, input, index));
    const validation = validateTrajectoryRoot(validationRoot);
    if (!validation.ok) mergeError('malformed_fragment', validation.problems.join('\n'));
  } finally {
    fs.rmSync(validationRoot, { recursive: true, force: true });
  }
}

function parseJournal(input: LifecycleInput): SourceFragment {
  const text = input.journalBytes.toString('utf8');
  if (!text.endsWith('\n')) return mergeError('malformed_fragment', 'Incomplete journal line');
  const lines = text.slice(0, -1).split('\n');
  const records = lines.map((line, index) => parseObject(Buffer.from(line), `${input.journalPath}:${index + 1}`));
  if (records.length < 1) return mergeError('malformed_fragment', 'Journal has no header');
  return {
    header: records[0] as SourceJournalHeader,
    events: records.slice(1) as SourceJournalEvent[],
    terminal: input.terminal,
  };
}

function partitionFragments(fragments: SourceFragment[]): { parent: SourceFragment; children: SourceFragment[] } {
  const parents = fragments.filter(fragment => fragment.header.thread_id === null);
  if (parents.length !== 1) return mergeError('malformed_fragment', 'Expected exactly one parent fragment');
  const children = fragments.filter(fragment => fragment.header.thread_id !== null);
  const ids = children.map(child => child.header.thread_id);
  if (new Set(ids).size !== ids.length) {
    return mergeError('ambiguous_subagent_link', 'Two child fragments claim one thread id');
  }
  return { parent: parents[0], children };
}

function assertRootIdentity(parent: SourceFragment, children: SourceFragment[]): void {
  const rootRunId = parent.header.root_run_id;
  if (children.some(child => child.header.root_run_id !== rootRunId)) {
    mergeError('malformed_fragment', 'Root run id differs between parent and child');
  }
  const modelHash = parent.header.model_execution_identity_hash;
  if (children.some(child => child.header.model_execution_identity_hash !== modelHash)) {
    mergeError('identity_hash_drift', 'Model execution identity differs between parent and child');
  }
}

function toolResults(events: SourceJournalEvent[]): Map<string, SourceJournalEvent[]> {
  const results = new Map<string, SourceJournalEvent[]>();
  for (const record of events) {
    const event = record.event;
    if (event.type !== 'tool_result') continue;
    results.set(event.toolUseId, [...(results.get(event.toolUseId) ?? []), record]);
  }
  return results;
}

function isThreadRun(name: string): boolean {
  return name === 'thread_run' || name === 'mcp__cortex-benchmark-thread__thread_run';
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function contentBlocks(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return null;
  const content = (value as Record<string, unknown>).content;
  return Array.isArray(content) ? content : null;
}

function textFromBlock(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const block = value as Record<string, unknown>;
  if (block.type !== 'text') return null;
  return typeof block.text === 'string' ? block.text : null;
}

function textBlockPayload(value: unknown): unknown {
  const blocks = contentBlocks(value);
  if (!blocks || blocks.length !== 1) return null;
  const text = textFromBlock(blocks[0]);
  return text === null ? null : parseJson(text);
}

function payloadThreadId(content: string): string | null {
  const parsed = parseJson(content);
  const payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    && typeof (parsed as Record<string, unknown>).thread_id === 'string'
    ? parsed : textBlockPayload(parsed);
  if (!payload || typeof payload !== 'object') return null;
  const threadId = (payload as Record<string, unknown>).thread_id;
  return typeof threadId === 'string' && threadId.length > 0 ? threadId : null;
}

function successfulResult(records: SourceJournalEvent[] | undefined): SourceJournalEvent {
  if (!records || records.length === 0) {
    return mergeError('unresolvable_subagent_link', 'Thread call has no tool result');
  }
  if (records.length !== 1) {
    return mergeError('ambiguous_subagent_link', 'Thread call has ambiguous tool results');
  }
  const event = records[0].event;
  if (event.type !== 'tool_result' || !event.ok) {
    return mergeError('unresolvable_subagent_link', 'Thread run has no successful result');
  }
  return records[0];
}

function threadIdFromResults(records: SourceJournalEvent[] | undefined): string {
  const record = successfulResult(records);
  const event = record.event as Extract<SourceJournalEvent['event'], { type: 'tool_result' }>;
  const threadId = payloadThreadId(event.content);
  if (!threadId) return mergeError('unresolvable_subagent_link', 'Thread result has no thread_id');
  return threadId;
}

function threadCalls(events: SourceJournalEvent[]): Array<{ callId: string }> {
  return events.flatMap(record => {
    const event = record.event;
    if (event.type !== 'tool_use' || !isThreadRun(event.name)) return [];
    return [{ callId: event.toolUseId }];
  });
}

function collectThreadLinks(events: SourceJournalEvent[]): ThreadLink[] {
  const results = toolResults(events);
  return threadCalls(events).map(call => ({
    callId: call.callId,
    threadId: threadIdFromResults(results.get(call.callId)),
  }));
}

function explicitLinksInCallOrder(
  events: SourceJournalEvent[], links: ThreadLink[],
): ThreadLink[] {
  const calls = threadCalls(events);
  const callIds = new Set(calls.map(call => call.callId));
  if (links.some(link => !callIds.has(link.callId))) {
    return mergeError('unresolvable_subagent_link', 'Explicit link has no thread_run tool call');
  }
  if (new Set(links.map(link => link.callId)).size !== links.length) {
    return mergeError('ambiguous_subagent_link', 'Thread call is explicitly linked more than once');
  }
  if (links.length !== calls.length) {
    return mergeError('unresolvable_subagent_link', 'Explicit link map is incomplete');
  }
  const byCall = new Map(links.map(link => [link.callId, link.threadId]));
  const results = toolResults(events);
  return calls.map(call => {
    successfulResult(results.get(call.callId));
    return { callId: call.callId, threadId: byCall.get(call.callId)! };
  });
}

function orderChildren(children: SourceFragment[], links: ThreadLink[]): SourceFragment[] {
  const childIds = children.map(child => child.header.thread_id as string);
  const linkIds = links.map(link => link.threadId);
  if (new Set(linkIds).size !== linkIds.length) {
    return mergeError('ambiguous_subagent_link', 'Two tool results claim one child thread');
  }
  const byId = new Map(children.map(child => [child.header.thread_id, child]));
  if (linkIds.some(threadId => !byId.has(threadId))) {
    return mergeError('missing_child_fragment', 'Resolved thread has no child fragment');
  }
  if (childIds.some(threadId => !linkIds.includes(threadId))) {
    return mergeError('unbound_child_fragment', 'Child fragment has no resolved tool result');
  }
  return links.map(link => byId.get(link.threadId)!);
}

function removeIfExists(filePath: string, fileSystem: TrajectoryMergeFileSystem): void {
  if (fileSystem.exists(filePath)) fileSystem.unlink(filePath);
}

function assertOutputPrecondition(
  outputPath: string, fileSystem: TrajectoryMergeFileSystem,
): void {
  if (fileSystem.exists(outputPath)) {
    mergeError('output_path_exists', 'Output path already exists');
  }
  try {
    fileSystem.access(path.dirname(outputPath), fs.constants.W_OK);
  } catch (error) {
    mergeError('output_path_not_writable', 'Output directory is not writable', error);
  }
}

function writeFull(fd: number, bytes: Buffer, fileSystem: TrajectoryMergeFileSystem): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fileSystem.write(fd, bytes, offset);
    if (written <= 0) return mergeError('malformed_fragment', 'Output write returned zero bytes');
    offset += written;
  }
}

function safeCleanup(filePath: string, fileSystem: TrajectoryMergeFileSystem): void {
  try {
    removeIfExists(filePath, fileSystem);
  } catch {}
}

function temporaryPath(outputPath: string): string {
  const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  return `${outputPath}.tmp.${nonce}`;
}

function linkOutput(
  temporary: string, outputPath: string, fileSystem: TrajectoryMergeFileSystem,
): void {
  try {
    fileSystem.link(temporary, outputPath);
  } catch (error) {
    if (isErrno(error, 'EEXIST')) {
      mergeError('output_path_exists', 'Output path was created during publication', error);
    }
    throw error;
  }
}

function publish(outputPath: string, bytes: Buffer, fileSystem: TrajectoryMergeFileSystem): void {
  const temporary = temporaryPath(outputPath);
  let fd: number | null = null;
  try {
    fd = fileSystem.open(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    writeFull(fd, bytes, fileSystem);
    fileSystem.fsync(fd);
    fileSystem.close(fd);
    fd = null;
    linkOutput(temporary, outputPath, fileSystem);
    safeCleanup(temporary, fileSystem);
  } catch (error) {
    if (fd !== null) {
      try { fileSystem.close(fd); } catch {}
    }
    safeCleanup(temporary, fileSystem);
    throw normalizeError(error);
  }
}

interface MetricAccumulator {
  prompt: number;
  completion: number;
  cached: number;
  cost: number;
  steps: number;
}

function underivable(detail: string): never {
  return mergeError('aggregate_metrics_underivable', detail);
}

function tokenMetric(value: unknown, field: string): number {
  if (Number.isSafeInteger(value) && Number(value) >= 0) return Number(value);
  return underivable(`Missing or invalid ${field}`);
}

function costMetric(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  return underivable('Missing or invalid cost_usd');
}

function sumToken(left: number, right: number, field: string): number {
  const total = left + right;
  if (Number.isSafeInteger(total)) return total;
  return underivable(`${field} aggregate exceeds safe integer range`);
}

function addCostRecord(total: MetricAccumulator, record: SourceJournalEvent): MetricAccumulator {
  const event = record.event;
  if (event.type !== 'cost_record') return total;
  return {
    ...total,
    prompt: sumToken(total.prompt, tokenMetric(event.prompt_tokens, 'prompt_tokens'), 'prompt_tokens'),
    completion: sumToken(total.completion, tokenMetric(event.tokens_out, 'tokens_out'), 'tokens_out'),
    cached: sumToken(total.cached, tokenMetric(event.cached_tokens, 'cached_tokens'), 'cached_tokens'),
    cost: total.cost + costMetric(event.cost_usd),
  };
}

function fragmentCostMetrics(fragment: SourceFragment): MetricAccumulator {
  const records = fragment.events.filter(record => record.event.type === 'cost_record');
  if (records.length === 0) return underivable('Fragment has no cost_record event');
  return records.reduce(addCostRecord, { prompt: 0, completion: 0, cached: 0, cost: 0, steps: 0 });
}

function fragmentSteps(fragment: SourceFragment): number {
  const records = fragment.events.filter(record => record.event.type === 'turn_complete');
  if (records.length === 0) return underivable('Fragment has no turn_complete event');
  return records.reduce((total, record) => {
    const event = record.event;
    if (event.type !== 'turn_complete') return total;
    return sumToken(total, tokenMetric(event.numTurns, 'numTurns'), 'numTurns');
  }, 0);
}

function assertContextUsage(fragment: SourceFragment): void {
  let hasContext = false;
  for (const record of fragment.events) {
    const event = record.event;
    if (event.type === 'context_usage'
        && Number.isSafeInteger(event.usedTokens) && Number(event.usedTokens) >= 0) {
      hasContext = true;
    }
    if (event.type !== 'cost_record') continue;
    if (!hasContext) underivable('Cost record has no preceding derivable context_usage event');
    hasContext = false;
  }
}

function fragmentMetrics(fragment: SourceFragment): MetricAccumulator {
  assertContextUsage(fragment);
  const metrics = fragmentCostMetrics(fragment);
  return { ...metrics, steps: fragmentSteps(fragment) };
}

function addFragmentMetrics(total: MetricAccumulator, fragment: SourceFragment): MetricAccumulator {
  const metrics = fragmentMetrics(fragment);
  return {
    prompt: sumToken(total.prompt, metrics.prompt, 'total_prompt_tokens'),
    completion: sumToken(total.completion, metrics.completion, 'total_completion_tokens'),
    cached: sumToken(total.cached, metrics.cached, 'total_cached_tokens'),
    cost: total.cost + metrics.cost,
    steps: sumToken(total.steps, metrics.steps, 'total_steps'),
  };
}

function aggregateFinalMetrics(fragments: SourceFragment[]): AtifFinalMetrics {
  const zero = { prompt: 0, completion: 0, cached: 0, cost: 0, steps: 0 };
  const total = fragments.reduce(addFragmentMetrics, zero);
  if (!Number.isFinite(total.cost)) return underivable('total_cost_usd is not finite');
  return {
    total_prompt_tokens: total.prompt,
    total_completion_tokens: total.completion,
    total_cached_tokens: total.cached,
    total_cost_usd: total.cost,
    total_steps: total.steps,
    extra: {
      prompt_tokens_definition:
        'input_tokens + cache_creation_input_tokens + cache_read_input_tokens',
      cached_tokens_definition: 'cache_read_input_tokens',
    },
  };
}

function fragmentOutcome(fragment: SourceFragment): FragmentOutcome {
  return {
    thread_id: fragment.header.thread_id,
    state: fragment.terminal.state,
    terminal_reason: fragment.terminal.terminal_reason,
  };
}

function resolveLinks(
  parent: SourceFragment, explicit: ThreadLink[] | undefined,
): { links: ThreadLink[]; source: 'tool_result' | 'explicit' } {
  if (!explicit || explicit.length === 0) {
    return { links: collectThreadLinks(parent.events), source: 'tool_result' };
  }
  return { links: explicitLinksInCallOrder(parent.events, explicit), source: 'explicit' };
}

function mergeBytes(
  root: string, fileSystem: TrajectoryMergeFileSystem, explicit: ThreadLink[] | undefined,
): { bytes: Buffer; trajectoryId: string; fragments: FragmentOutcome[] } {
  const inputs = loadInputs(root, fileSystem);
  validateSnapshot(inputs);
  const fragments = inputs.map(parseJournal);
  const { parent, children } = partitionFragments(fragments);
  assertRootIdentity(parent, children);
  const resolved = resolveLinks(parent, explicit);
  const orderedChildren = orderChildren(children, resolved.links);
  const orderedFragments = [parent, ...orderedChildren];
  const finalMetrics = aggregateFinalMetrics(orderedFragments);
  const trajectory = buildAtifTree(
    parent, orderedChildren, resolved.links, resolved.source, finalMetrics,
  );
  const outcomes = orderedFragments.map(fragmentOutcome);
  return {
    bytes: Buffer.from(`${JSON.stringify(trajectory, null, 2)}\n`),
    trajectoryId: trajectory.trajectory_id,
    fragments: outcomes,
  };
}

export function mergeTrajectory(
  options: MergeTrajectoryOptions,
  fileSystem: TrajectoryMergeFileSystem = NODE_TRAJECTORY_MERGE_FS,
): MergeTrajectoryResult {
  const outputPath = path.resolve(options.outputPath);
  try {
    assertOutputPrecondition(outputPath, fileSystem);
    const merged = mergeBytes(
      path.resolve(options.trajectoryRoot), fileSystem, options.subagentLinks,
    );
    publish(outputPath, merged.bytes, fileSystem);
    return {
      outputPath,
      sha256: createHash('sha256').update(merged.bytes).digest('hex'),
      trajectoryId: merged.trajectoryId,
      fragments: merged.fragments,
    };
  } catch (error) {
    throw normalizeError(error);
  }
}
