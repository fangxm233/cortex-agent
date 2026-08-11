// input:  lifecycle journals with control records and output path
// output: state-gated ATIF metrics or typed fail-closed errors
// pos:    Parent-plus-child journal merge boundary
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StateAdmissionEvidence } from './journal.js';
import { validateTrajectoryRoot } from './manifest.js';
import {
  mintAttemptId, type AttemptEdge, type AttemptRecord, type EndpointRef,
} from '../benchmark/attempt-record.js';
import type { NormalizedEvent } from '../../agent-adapter/normalize/event-types.js';
import {
  buildAtifTree,
  type AtifFinalMetrics,
  type AtifNode,
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

/**
 * The subset of §9.2's composite manifest the merge walks. A `CompositeManifest` satisfies it
 * structurally, which keeps `composite-manifest.ts` → `trajectory-merge.ts` the only dependency
 * direction between the two modules while still letting the merge read the real document.
 */
export interface AttemptDag {
  readonly nodes: readonly AttemptRecord[];
  readonly edges: readonly AttemptEdge[];
  readonly roots: { readonly parent_attempt_id: string };
  /** §9.3 M4 / design B-1: a role-indexed MAP, never a scalar. A scalar cannot be indexed by role
   *  and would silently degrade M4 back to the shipped parent-equality check. */
  readonly identity: { readonly model_execution_identity_hash: Readonly<Record<string, string>> };
}

export interface MergeTrajectoryOptions {
  trajectoryRoot: string;
  outputPath: string;
  subagentLinks?: ThreadLink[];
  parentStateAdmission?: StateAdmissionEvidence;
  /**
   * §9.2's attempt DAG. When supplied, the merge partitions at `roots.parent_attempt_id` and
   * recurses over the authoritative edges (§9.3 M2/M3) and indexes identity by role (M4). Without
   * it the merge keeps the shipped one-level, tool-result-derived path — the modes that have no
   * composite manifest producer yet.
   */
  attemptDag?: AttemptDag;
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

function validateSnapshot(
  inputs: LifecycleInput[],
  parentStateAdmission?: StateAdmissionEvidence,
): void {
  const validationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trajectory-merge-validate-'));
  try {
    inputs.forEach((input, index) => writeValidationInput(validationRoot, input, index));
    const validation = validateTrajectoryRoot(validationRoot, { parentStateAdmission });
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
    events: records.slice(1).filter(record => record.type === 'event') as SourceJournalEvent[],
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

// ---------------------------------------------------------------------------------------------
// §9.3 M2/M3/M4/M7 — the plan the builder walks, rooted in the attempt DAG
// ---------------------------------------------------------------------------------------------

interface PlanNode extends AtifNode {
  readonly fragment: SourceFragment;
  readonly links: ThreadLink[];
  readonly children: PlanNode[];
}

/** §9.2's parent→child subset. `depends_on` is task→task ordering, not descent, and is excluded. */
const DAG_EDGE_KINDS = new Set<AttemptEdge['kind']>(['spawn', 'decompose', 'dispatch']);
const ATTEMPT_PREFIX = 'attempt\u0000';

function endpointKey(ref: EndpointRef): string {
  return ref.ref === 'direct-parent' ? 'direct-parent\u0000' : `${ref.ref}\u0000${ref.id}`;
}

function dagAdjacency(edges: readonly AttemptEdge[]): ReadonlyMap<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!DAG_EDGE_KINDS.has(edge.kind)) continue;
    const from = endpointKey(edge.from);
    const bucket = adjacency.get(from);
    if (bucket) bucket.push(endpointKey(edge.to));
    else adjacency.set(from, [endpointKey(edge.to)]);
  }
  return adjacency;
}

/**
 * The attempts exactly one ATTEMPT hop below `attemptId`. Task vertices are transparent: a manager
 * descends `attempt --decompose→ task --dispatch→ attempt`, so a walk that only followed
 * attempt→attempt edges would see a manager tree as a flat list of one.
 */
function childAttempts(adjacency: ReadonlyMap<string, string[]>, attemptId: string): string[] {
  const children: string[] = [];
  const seen = new Set<string>();
  const queue = [`${ATTEMPT_PREFIX}${attemptId}`];
  while (queue.length > 0) {
    for (const next of adjacency.get(queue.shift()!) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      if (next.startsWith(ATTEMPT_PREFIX)) children.push(next.slice(ATTEMPT_PREFIX.length));
      else queue.push(next);
    }
  }
  return children;
}

function fragmentAttemptId(fragment: SourceFragment): string {
  return mintAttemptId(fragment.header.root_run_id, fragment.header.thread_id);
}

interface DagDescent {
  readonly childrenOf: ReadonlyMap<string, string[]>;
  readonly reachable: ReadonlySet<string>;
}

/** One parent per attempt: the published ATIF is a tree, so an attempt two parents claim has no
 *  single place in it. Also catches a cycle, which re-visits an already-claimed attempt. */
function descend(dag: AttemptDag, rootId: string): DagDescent {
  const adjacency = dagAdjacency(dag.edges);
  const childrenOf = new Map<string, string[]>();
  const reachable = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const children = childAttempts(adjacency, current);
    childrenOf.set(current, children);
    for (const child of children) {
      if (reachable.has(child)) {
        mergeError('ambiguous_subagent_link', `Two attempts claim child attempt ${child}`);
      }
      reachable.add(child);
      queue.push(child);
    }
  }
  return { childrenOf, reachable };
}

function indexFragments(fragments: SourceFragment[]): ReadonlyMap<string, SourceFragment> {
  const byAttempt = new Map<string, SourceFragment>();
  for (const fragment of fragments) {
    const attemptId = fragmentAttemptId(fragment);
    if (byAttempt.has(attemptId)) {
      mergeError('ambiguous_subagent_link', `Two fragments claim attempt ${attemptId}`);
    }
    byAttempt.set(attemptId, fragment);
  }
  return byAttempt;
}

function indexNodes(dag: AttemptDag): ReadonlyMap<string, number> {
  const order = new Map<string, number>();
  dag.nodes.forEach((node, index) => {
    if (order.has(node.attempt_id)) {
      mergeError('ambiguous_subagent_link', `Two nodes claim attempt ${node.attempt_id}`);
    }
    order.set(node.attempt_id, index);
  });
  return order;
}

/**
 * §9.3 M7, generalised from a flat list to DAG nodes ↔ lifecycle pairs. Every unaccounted attempt
 * gets a NAMED refusal; nothing is dropped and nothing is reconstructed by guess.
 */
function assertDagCompleteness(
  dag: AttemptDag,
  descent: DagDescent,
  order: ReadonlyMap<string, number>,
  byAttempt: ReadonlyMap<string, SourceFragment>,
): void {
  for (const attemptId of descent.reachable) {
    if (!order.has(attemptId)) {
      mergeError('missing_child_fragment', `Edge reaches undeclared attempt ${attemptId}`);
    }
  }
  for (const node of dag.nodes) {
    if (!descent.reachable.has(node.attempt_id)) {
      mergeError('unresolvable_subagent_link', `Attempt ${node.attempt_id} is not reachable from the root`);
    }
    if (!byAttempt.has(node.attempt_id)) {
      mergeError('missing_child_fragment', `Attempt ${node.attempt_id} has no lifecycle pair`);
    }
  }
  for (const attemptId of byAttempt.keys()) {
    if (!order.has(attemptId)) {
      mergeError('unbound_child_fragment', `Lifecycle pair ${attemptId} has no attempt node`);
    }
  }
}

/**
 * §9.3 M4 / design B-1 — an INDEXING operation. The attempt's own scalar MEIH (§9.1) must equal
 * `identity.model_execution_identity_hash[attempt.role]`; a role with no entry, or an entry the
 * attempt disagrees with, is `identity_hash_drift`. `plan:222` permits heterogeneous role models
 * when frozen in policy, which parent-equality cannot express.
 */
function assertRoleIndexedIdentity(
  dag: AttemptDag, byAttempt: ReadonlyMap<string, SourceFragment>,
): void {
  const frozen = dag.identity.model_execution_identity_hash;
  for (const node of dag.nodes) {
    if (!Object.hasOwn(frozen, node.role)) {
      mergeError('identity_hash_drift', `Role ${node.role} has no frozen model execution identity`);
    }
    const observed = byAttempt.get(node.attempt_id)!.header.model_execution_identity_hash;
    if (observed !== frozen[node.role]) {
      mergeError('identity_hash_drift', `Attempt ${node.attempt_id} disagrees with its role's frozen identity`);
    }
  }
}

function assertOneRootRunId(fragments: SourceFragment[], rootRunId: string): void {
  if (fragments.some(fragment => fragment.header.root_run_id !== rootRunId)) {
    mergeError('malformed_fragment', 'Root run id differs between attempts');
  }
}

/** Links annotate observations only. In the DAG path they must still name a child of their OWN
 *  node, or the published `subagent_trajectory_ref` would point outside this node's subtree. */
function nodeLinks(
  fragment: SourceFragment, children: readonly PlanNode[], explicit: ThreadLink[] | undefined,
): ThreadLink[] {
  const callIds = new Set(threadCalls(fragment.events).map(call => call.callId));
  const own = explicit === undefined
    ? collectThreadLinks(fragment.events)
    : explicitLinksInCallOrder(fragment.events, explicit.filter(link => callIds.has(link.callId)));
  const childThreads = new Set(children.map(child => child.fragment.header.thread_id));
  if (own.some(link => !childThreads.has(link.threadId))) {
    mergeError('unresolvable_subagent_link', 'Resolved link names an attempt that is not a child of its caller');
  }
  return own;
}

function planNode(
  attemptId: string,
  descent: DagDescent,
  order: ReadonlyMap<string, number>,
  byAttempt: ReadonlyMap<string, SourceFragment>,
  explicit: ThreadLink[] | undefined,
): PlanNode {
  const fragment = byAttempt.get(attemptId)!;
  // G4-CM12's total order is the manifest's own; re-deriving one here would make the published
  // tree depend on the merge instead of on the document it walks.
  const children = [...(descent.childrenOf.get(attemptId) ?? [])]
    .sort((left, right) => order.get(left)! - order.get(right)!)
    .map(child => planNode(child, descent, order, byAttempt, explicit));
  return { fragment, links: nodeLinks(fragment, children, explicit), children };
}

function planFromDag(
  fragments: SourceFragment[], dag: AttemptDag, explicit: ThreadLink[] | undefined,
): PlanNode {
  const rootId = dag.roots.parent_attempt_id;
  const order = indexNodes(dag);
  if (!order.has(rootId)) {
    mergeError('malformed_fragment', `Root attempt ${rootId} is not declared by the manifest`);
  }
  const byAttempt = indexFragments(fragments);
  const descent = descend(dag, rootId);
  assertDagCompleteness(dag, descent, order, byAttempt);
  assertOneRootRunId(fragments, byAttempt.get(rootId)!.header.root_run_id);
  assertRoleIndexedIdentity(dag, byAttempt);
  return planNode(rootId, descent, order, byAttempt, explicit);
}

/** The shipped one-level path, unchanged, for the modes with no composite manifest producer. */
function planFromLinks(
  fragments: SourceFragment[], explicit: ThreadLink[] | undefined,
): { root: PlanNode; source: 'tool_result' | 'explicit' } {
  const { parent, children } = partitionFragments(fragments);
  assertRootIdentity(parent, children);
  const resolved = resolveLinks(parent, explicit);
  return {
    root: {
      fragment: parent,
      links: resolved.links,
      children: orderChildren(children, resolved.links)
        .map(child => ({ fragment: child, links: [], children: [] })),
    },
    source: resolved.source,
  };
}

function buildPlan(
  fragments: SourceFragment[], options: MergeTrajectoryOptions,
): { root: PlanNode; source: 'tool_result' | 'explicit' } {
  const explicit = options.subagentLinks?.length ? options.subagentLinks : undefined;
  if (!options.attemptDag) return planFromLinks(fragments, explicit);
  return {
    root: planFromDag(fragments, options.attemptDag, explicit),
    source: explicit === undefined ? 'tool_result' : 'explicit',
  };
}

function planFragments(node: PlanNode): SourceFragment[] {
  return [node.fragment, ...node.children.flatMap(planFragments)];
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
  /** §17 G4-SA8 — derived native-subagent turns. Never folded into `steps`. */
  subagentTurns: number;
}

const ZERO_METRICS: MetricAccumulator = {
  prompt: 0, completion: 0, cached: 0, cost: 0, steps: 0, subagentTurns: 0,
};

/**
 * §17 G4-SA12 — the census key, BINDING. The CLI declares `Agent` and `Task` as two live constants
 * for ONE tool and its own subagent-type extractor tests both, so a census keyed on `Agent` alone
 * passes vacuously on a transcript that emitted the alias — reintroducing the invisibility OC-11
 * exists to close. Exported so §9.4's F7 evaluation uses this predicate rather than restating it.
 */
export function isNativeSubagentCall(
  event: NormalizedEvent,
): event is Extract<NormalizedEvent, { type: 'tool_use' }> {
  return event.type === 'tool_use' && (event.name === 'Agent' || event.name === 'Task');
}

/**
 * §17 G4-SA10 — A2's "refuses to guess", in the strong direction, and the census↔call bijection is
 * checked BOTH WAYS because this function owns that bijection and each direction fails open on its
 * own. Forwards: an `Agent`/`Task` call with zero census events would have to be reported as zero
 * turns, which asserts that a subagent that demonstrably ran produced nothing. Backwards: a census
 * event naming a call this fragment never made would contribute a turn to a parent that does not
 * exist, so the turn total is not derivable from this fragment either. The merge says "I don't
 * know" in both directions rather than guessing.
 */
function assertSubagentCensus(fragment: SourceFragment): void {
  const attested = new Set(fragment.events.flatMap(record => (
    record.event.type === 'subagent_activity' ? [record.event.parentToolUseId] : []
  )));
  const called = new Set(fragment.events.flatMap(record => (
    isNativeSubagentCall(record.event) ? [record.event.toolUseId] : []
  )));
  for (const record of fragment.events) {
    const event = record.event;
    if (!isNativeSubagentCall(event) || attested.has(event.toolUseId)) continue;
    underivable(`Native subagent call ${event.toolUseId} has no subagent_activity event`);
  }
  for (const parentToolUseId of attested) {
    if (called.has(parentToolUseId)) continue;
    underivable(`subagent_activity names ${parentToolUseId}, which this fragment never called`);
  }
}

/** §17 G4-SA8 — one turn per subagent ASSISTANT line. A `tool_result` line is the subagent's tool
 *  coming back, not a turn it took. */
function fragmentSubagentTurns(fragment: SourceFragment): number {
  return fragment.events.reduce((total, record) => {
    const event = record.event;
    if (event.type !== 'subagent_activity' || event.kind !== 'assistant') return total;
    return sumToken(total, 1, 'subagent_turns');
  }, 0);
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
  return records.reduce(addCostRecord, { ...ZERO_METRICS });
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

function fragmentMetrics(fragment: SourceFragment): MetricAccumulator {
  const metrics = fragmentCostMetrics(fragment);
  assertSubagentCensus(fragment);
  return {
    ...metrics,
    steps: fragmentSteps(fragment),
    subagentTurns: fragmentSubagentTurns(fragment),
  };
}

function addFragmentMetrics(total: MetricAccumulator, fragment: SourceFragment): MetricAccumulator {
  const metrics = fragmentMetrics(fragment);
  return {
    prompt: sumToken(total.prompt, metrics.prompt, 'total_prompt_tokens'),
    completion: sumToken(total.completion, metrics.completion, 'total_completion_tokens'),
    cached: sumToken(total.cached, metrics.cached, 'total_cached_tokens'),
    cost: total.cost + metrics.cost,
    steps: sumToken(total.steps, metrics.steps, 'total_steps'),
    subagentTurns: sumToken(total.subagentTurns, metrics.subagentTurns, 'subagent_turns'),
  };
}

function assertMetricsDerivable(fragments: SourceFragment[]): void {
  for (const fragment of fragments) fragmentMetrics(fragment);
}

/** §9.3 M6 — summed RECURSIVELY over the DAG, keeping the safe-integer guards. A sum over the root
 *  and its direct children alone would silently omit every grandchild's spend. */
function addPlanMetrics(total: MetricAccumulator, node: PlanNode): MetricAccumulator {
  return node.children.reduce(addPlanMetrics, addFragmentMetrics(total, node.fragment));
}

function aggregateFinalMetrics(root: PlanNode): AtifFinalMetrics {
  const total = addPlanMetrics({ ...ZERO_METRICS }, root);
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
      subagent_turns: total.subagentTurns,
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
  root: string, fileSystem: TrajectoryMergeFileSystem, options: MergeTrajectoryOptions,
): { bytes: Buffer; trajectoryId: string; fragments: FragmentOutcome[] } {
  const inputs = loadInputs(root, fileSystem);
  // M5 and M8 hold for every node of the DAG because every node is one of these inputs.
  assertContainment(inputs);
  const fragments = inputs.map(parseJournal);
  assertMetricsDerivable(fragments);
  validateSnapshot(inputs, options.parentStateAdmission);
  const plan = buildPlan(fragments, options);
  const finalMetrics = aggregateFinalMetrics(plan.root);
  const trajectory = buildAtifTree(plan.root, plan.source, finalMetrics);
  return {
    bytes: Buffer.from(`${JSON.stringify(trajectory, null, 2)}\n`),
    trajectoryId: trajectory.trajectory_id,
    fragments: planFragments(plan.root).map(fragmentOutcome),
  };
}

export function mergeTrajectory(
  options: MergeTrajectoryOptions,
  fileSystem: TrajectoryMergeFileSystem = NODE_TRAJECTORY_MERGE_FS,
): MergeTrajectoryResult {
  const outputPath = path.resolve(options.outputPath);
  try {
    assertOutputPrecondition(outputPath, fileSystem);
    const merged = mergeBytes(path.resolve(options.trajectoryRoot), fileSystem, options);
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
