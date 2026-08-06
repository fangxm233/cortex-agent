// input:  fragments, links, metrics, print-mode tool progress
// output: deterministic ATIF-v1.7 tree with documented metrics
// pos:    Journal-to-ATIF conversion boundary
// >>> If I am updated, update my header and folder CORTEX.md <<<

import type { NormalizedEvent } from '../../agent-adapter/normalize/event-types.js';

export interface SourceJournalHeader extends Record<string, unknown> {
  schema_version: string;
  root_run_id: string;
  thread_id: string | null;
  agent_slot: string;
  resolved_cwd: string;
  model_execution_identity_hash: string;
  role_tool_surface_hash: string;
  bundle_manifest_hash: string;
}

export interface SourceJournalEvent extends Record<string, unknown> {
  root_run_id: string;
  thread_id: string | null;
  agent_slot: string;
  seq: number;
  ts: string;
  requested_model: string;
  reported_model: string | null;
  event: NormalizedEvent;
}

export interface SourceFragment {
  header: SourceJournalHeader;
  events: SourceJournalEvent[];
  terminal: Record<string, unknown>;
}

export interface ThreadLink {
  callId: string;
  threadId: string;
}

/**
 * One node of the attempt DAG as the ATIF builder walks it (§9.3 M3). `links` are the tool calls
 * THIS node made that resolve to a child trajectory; they annotate observations and never define
 * structure — a manager edge (`decompose`/`dispatch`) appears in no tool result at all, so `links`
 * is legitimately empty while `children` is not.
 */
export interface AtifNode {
  readonly fragment: SourceFragment;
  readonly links: readonly ThreadLink[];
  readonly children: readonly AtifNode[];
}

export interface AtifFinalMetrics {
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_cached_tokens: number;
  total_cost_usd: number;
  total_steps: number;
  extra: {
    prompt_tokens_definition: string;
    cached_tokens_definition: string;
    /**
     * §17 G4-SA11 — native-subagent turns, DERIVED by Cortex from the journal's census events
     * because the CLI maintains no such counter (G4-SA4). Carried BESIDE `total_steps`, never
     * summed into it: `total_steps` is the parent's own turn total. Reconciling the two would
     * erase exactly the distinction this field exists to record.
     */
    subagent_turns: number;
  };
}

export interface AtifTrajectory {
  schema_version: 'ATIF-v1.7';
  session_id?: string;
  trajectory_id: string;
  agent: Record<string, unknown>;
  steps: Array<Record<string, unknown>>;
  notes?: string;
  final_metrics?: AtifFinalMetrics;
  extra: Record<string, unknown>;
  subagent_trajectories?: AtifTrajectory[];
}

interface EventGroup {
  records: SourceJournalEvent[];
}

function malformed(message: string): never {
  throw new Error(`malformed_fragment:${message}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function eventType(record: SourceJournalEvent): string {
  return record.event.type;
}

function collectToolUses(
  events: SourceJournalEvent[], start: number,
): { records: SourceJournalEvent[]; next: number } {
  const records: SourceJournalEvent[] = [];
  let index = start;
  while (index < events.length && eventType(events[index]) === 'tool_use') {
    records.push(events[index]);
    index += 1;
  }
  return { records, next: index };
}

function collectToolResults(
  events: SourceJournalEvent[], start: number, callIds: Set<string>,
  attested: ReadonlySet<string>,
): { records: SourceJournalEvent[]; next: number } {
  const records: SourceJournalEvent[] = [];
  // Calls in this batch that a `subagent_activity` event attests — i.e. the spans in which a
  // native subagent is producing output of its own. Emptied as each one's result arrives.
  const openSubagentCalls = new Set([...callIds].filter(id => attested.has(id)));
  let index = start;
  while (index < events.length) {
    const record = events[index];
    // Progress and native-subagent census events interleave with the results of the call that is
    // still open — a subagent's lines land between its `Agent`/`Task` call and that call's result.
    // Absorbing them keeps the batch contiguous; breaking on them would orphan the result.
    if (eventType(record) === 'turn_progress' || eventType(record) === 'subagent_activity') {
      records.push(record);
      index += 1;
      continue;
    }
    const result = record.event;
    if (result.type === 'tool_result' && callIds.has(result.toolUseId)) {
      openSubagentCalls.delete(result.toolUseId);
      records.push(record);
      index += 1;
      continue;
    }
    // A native subagent runs INSIDE its caller's tool call, so its own text and tool events land
    // between that call and that call's result (D-ADDITIVE keeps them flowing to the handlers that
    // journal them). While such a call is open and attested, those events belong to this batch.
    // Nothing is absorbed on an unattested call, so `unpaired_tool_result` keeps its full strength
    // for every journal that has no native-subagent census.
    if (openSubagentCalls.size === 0) break;
    records.push(record);
    index += 1;
  }
  // The allowance above is BOUNDED by the attested call's own result, and nothing else in the
  // journal marks that boundary: the adapter pushes `turn_complete` once, immediately before
  // `stream.close()` (`claude/adapter.ts:1444-1449`), and `turn_progress` is absorbed at :126
  // precisely because it lands mid-span. So reaching the end of the fragment with a span still
  // open means the journal never said where the subagent's output stopped — and every record from
  // the call onward was pushed RAW, so no batch guard inspected any of it. §9.6 A2 refuses rather
  // than guessing a boundary; §17 G4-SA10 is fail-closed by design.
  if (openSubagentCalls.size > 0) malformed('unclosed_subagent_span');
  return { records, next: index };
}

function toolBatch(
  events: SourceJournalEvent[], start: number, attested: ReadonlySet<string>,
): { group: EventGroup; next: number } {
  const uses = collectToolUses(events, start);
  const callIds = new Set(uses.records.map(record => {
    const event = record.event;
    return event.type === 'tool_use' ? event.toolUseId : '';
  }));
  if (callIds.size !== uses.records.length) malformed('duplicate_tool_call_id');
  const results = collectToolResults(events, uses.next, callIds, attested);
  const resultIds = results.records.flatMap(record => (
    record.event.type === 'tool_result' ? [record.event.toolUseId] : []
  ));
  if (new Set(resultIds).size !== resultIds.length) malformed('duplicate_tool_result');
  // Absorbed records are INSIDE this batch, so the batch's uniqueness rules bind them too.
  // `resultIds` above already spans them because it reads `results.records`; the call-id check at
  // :166 could not, because `callIds` has to exist before absorption starts. That asymmetry is
  // what let a duplicate call id ride into a cleanly closed span unseen. Result PAIRING stays
  // relaxed inside the span — a native subagent's own result legitimately has no call here — but
  // an id emitted twice is corruption in any agent's id space, and the two checks now agree.
  const batchCallIds = [...callIds, ...results.records.flatMap(record => (
    record.event.type === 'tool_use' ? [record.event.toolUseId] : []
  ))];
  if (new Set(batchCallIds).size !== batchCallIds.length) malformed('duplicate_tool_call_id');
  return { group: { records: [...uses.records, ...results.records] }, next: results.next };
}

/** The tool calls this fragment's census events attest a native subagent ran under (§17 G4-SA6). */
function attestedSubagentCalls(events: SourceJournalEvent[]): ReadonlySet<string> {
  return new Set(events.flatMap(record => (
    record.event.type === 'subagent_activity' ? [record.event.parentToolUseId] : []
  )));
}

/** Preserve each fragment's C2 seq order; contiguous tool calls and results form one ATIF step. */
function groupEvents(events: SourceJournalEvent[]): EventGroup[] {
  const groups: EventGroup[] = [];
  const attested = attestedSubagentCalls(events);
  let index = 0;
  while (index < events.length) {
    const type = eventType(events[index]);
    if (type === 'tool_result') malformed('unpaired_tool_result');
    if (type !== 'tool_use') {
      groups.push({ records: [events[index]] });
      index += 1;
      continue;
    }
    const batch = toolBatch(events, index, attested);
    groups.push(batch.group);
    index = batch.next;
  }
  return groups;
}

function toolArguments(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : { value };
}

function toolCalls(group: EventGroup): Array<Record<string, unknown>> {
  return group.records.flatMap(record => {
    const event = record.event;
    if (event.type !== 'tool_use') return [];
    return [{
      tool_call_id: event.toolUseId,
      function_name: event.name,
      arguments: toolArguments(event.input),
    }];
  });
}

function observationResults(
  group: EventGroup, links: ReadonlyMap<string, string>,
): Array<Record<string, unknown>> {
  return group.records.flatMap(record => {
    const event = record.event;
    if (event.type !== 'tool_result') return [];
    const childId = links.get(event.toolUseId);
    return [{
      source_call_id: event.toolUseId,
      content: event.content,
      subagent_trajectory_ref: childId ? [{ trajectory_id: childId }] : null,
      extra: { ok: event.ok },
    }];
  });
}

function stepMessage(group: EventGroup): string {
  if (group.records.length === 1) {
    const event = group.records[0].event;
    if (event.type === 'assistant_text' || event.type === 'assistant_delta') return event.text;
  }
  return JSON.stringify(group.records.map(record => record.event));
}

function buildStep(
  group: EventGroup, stepId: number, links: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const first = group.records[0];
  const calls = toolCalls(group);
  const results = observationResults(group, links);
  return {
    step_id: stepId,
    timestamp: first.ts,
    source: 'agent',
    model_name: first.reported_model,
    message: stepMessage(group),
    reasoning_content: null,
    ...(calls.length > 0 ? { tool_calls: calls } : {}),
    ...(results.length > 0 ? { observation: { results } } : {}),
    extra: { source_events: group.records },
  };
}

function buildAgent(fragment: SourceFragment): Record<string, unknown> {
  return {
    name: `cortex-${fragment.header.agent_slot}`,
    version: fragment.header.bundle_manifest_hash,
    model_name: fragment.events[0]?.requested_model ?? null,
    extra: {
      agent_slot: fragment.header.agent_slot,
      model_execution_identity_hash: fragment.header.model_execution_identity_hash,
      role_tool_surface_hash: fragment.header.role_tool_surface_hash,
      bundle_manifest_hash: fragment.header.bundle_manifest_hash,
      journal_schema_version: fragment.header.schema_version,
    },
  };
}

function trajectoryExtra(fragment: SourceFragment): Record<string, unknown> {
  return {
    root_run_id: fragment.header.root_run_id,
    thread_id: fragment.header.thread_id,
    agent_slot: fragment.header.agent_slot,
    resolved_cwd: fragment.header.resolved_cwd,
    model_execution_identity_hash: fragment.header.model_execution_identity_hash,
    role_tool_surface_hash: fragment.header.role_tool_surface_hash,
    bundle_manifest_hash: fragment.header.bundle_manifest_hash,
    journal_sha256: fragment.terminal.journal_sha256,
    terminal: {
      state: fragment.terminal.state,
      terminal_reason: fragment.terminal.terminal_reason,
    },
  };
}

function terminalStep(fragment: SourceFragment): Record<string, unknown> {
  const state = String(fragment.terminal.state);
  const reason = String(fragment.terminal.terminal_reason);
  return {
    step_id: 1,
    timestamp: fragment.terminal.ended_at,
    source: 'system',
    message: `Terminal state ${state}; reason ${reason}`,
    extra: { synthesized_from: 'terminal_manifest' },
  };
}

function buildSteps(
  fragment: SourceFragment, links: ReadonlyMap<string, string>,
): Array<Record<string, unknown>> {
  if (fragment.events.length === 0) return [terminalStep(fragment)];
  return groupEvents(fragment.events).map((group, index) => buildStep(group, index + 1, links));
}

/**
 * §9.3 M3 — recursive. Every node is built with ITS OWN link map, so nesting follows the DAG to
 * whatever depth the DAG has: one level for `coder-review` (§9.4 C7), the full depth for `manager`
 * (§9.4 M-16). The two are the same code because depth is a property of the DAG, not of the builder.
 */
function buildTrajectory(node: AtifNode): AtifTrajectory {
  const fragment = node.fragment;
  const links = new Map(node.links.map(link => [link.callId, link.threadId]));
  const id = fragment.header.thread_id ?? fragment.header.root_run_id;
  const trajectory: AtifTrajectory = {
    schema_version: 'ATIF-v1.7',
    trajectory_id: id,
    agent: buildAgent(fragment),
    steps: buildSteps(fragment, links),
    extra: trajectoryExtra(fragment),
  };
  if (fragment.header.thread_id === null) trajectory.session_id = fragment.header.root_run_id;
  if (node.children.length > 0) {
    trajectory.subagent_trajectories = node.children.map(buildTrajectory);
  }
  return trajectory;
}

function treeStepCount(trajectory: AtifTrajectory): number {
  const childSteps = (trajectory.subagent_trajectories ?? [])
    .reduce((total, child) => total + treeStepCount(child), 0);
  return trajectory.steps.length + childSteps;
}

function attachFinalMetrics(root: AtifTrajectory, metrics: AtifFinalMetrics): AtifTrajectory {
  root.final_metrics = metrics;
  const atifSteps = treeStepCount(root);
  if (metrics.total_steps !== atifSteps) {
    root.notes = `final_metrics.total_steps=${metrics.total_steps} sums journal `
      + `turn_complete.numTurns across parent and subagent fragments; the ATIF tree has `
      + `${atifSteps} steps because it preserves normalized accounting and tool events.`;
  }
  return root;
}

/** Children arrive already ordered by the caller — call order, or the DAG's own node order for a
 *  manager tree. Timestamps never order trajectories. */
export function buildAtifTree(
  root: AtifNode,
  linkSource: 'tool_result' | 'explicit',
  finalMetrics: AtifFinalMetrics,
): AtifTrajectory {
  const trajectory = buildTrajectory(root);
  trajectory.extra.subagent_link_source = linkSource;
  return attachFinalMetrics(trajectory, finalMetrics);
}
