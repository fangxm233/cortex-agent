import type { SystemTurnOrigin, TranscriptMessage } from '@cortex-agent/ui-contract';
import type { ChatRow } from './chat-row';
import { systemOriginBody } from './system-origin';

// Team mode in a lead's transcript. The lead's worker tools (spawn / send / answer / stop) leave the
// tool-chip run and become rows of their own, and everything its workers send back — reports,
// questions, plans, routine updates — collapses into one update card per consecutive run, so a
// worker that ended eight turns in a row reads as one card instead of eight identical lines. A
// routine update (a `worker-progress` row: a turn the worker marked as nothing new for the lead) is
// the quiet kind: the card leads with the run's reports and requests and counts routine apart.
//
// Structured fields win when the server sends them (`teamAction` on tool rows, `worker` on progress
// rows). History written before them carries only a capped `toolInput` summary and the report's
// header line, so both are parsed best-effort: a cut-off message stays a prefix, an unknown worker
// stays unknown.

export type TeamOp = 'spawn' | 'send' | 'answer' | 'stop';

const TEAM_TOOLS: Record<string, TeamOp> = {
  worker_spawn: 'spawn', worker_send: 'send', worker_answer: 'answer', worker_stop: 'stop',
};

/** A lead's action on one worker, as its row shows it. */
export interface TeamActionView {
  op: TeamOp;
  /** Null when the row does not say (a spawn summary, an answer whose request is not in view). */
  worker: string | null;
  /** spawn: the prompt; send: the message; answer: the answer or the plan feedback. */
  text: string | null;
  /** `text` is a prefix: history kept only a capped summary of the call. */
  partial: boolean;
  model: string | null;
  /** answer to a plan: approved (true) or rejected (false); absent for a question's answer. */
  approved?: boolean;
  /** answer only: the request it answers, when the row names it. */
  requestId: string | null;
  ts: string | null;
}

/** `progress` is a routine update; the other kinds are what the lead acts on. */
export type WorkerUpdateKind = 'report' | 'progress' | 'question' | 'plan';

/** The lead's answer to a question or plan, folded onto that request. */
export interface WorkerAnswer {
  approved?: boolean;
  text: string | null;
  partial: boolean;
  ts: string | null;
}

/** One thing a worker sent its lead. */
export interface WorkerUpdate {
  kind: WorkerUpdateKind;
  worker: string;
  /** Known on progress rows only; reports and requests name the worker, not its session. */
  sessionId: string | null;
  /** Full text, Markdown: the report, the question(s), or the plan. */
  body: string;
  /** One line of plain text for the collapsed card and the timeline. */
  line: string;
  ts: string | null;
  /** A report's turn ended badly. A completed turn says nothing: the worker may well be running. */
  outcome?: 'failed' | 'stopped';
  /** question / plan: the request id, when the header names it. */
  requestId?: string;
  /** question / plan: the lead's answer, wherever in the transcript it came. */
  answer?: WorkerAnswer;
}

/** One worker's share of an update card. */
export interface WorkerThread {
  worker: string;
  sessionId: string | null;
  updates: WorkerUpdate[];
  /** This is the worker's last card in the transcript — the only one that shows its live status. */
  latest: boolean;
}

export type TeamActionRow = { kind: 'team-action'; action: TeamActionView };
export type TeamUpdatesRow = {
  kind: 'team-updates';
  /** Stable while the card grows: its first update. */
  id: string;
  /** Every update in arrival order — the expanded timeline. */
  updates: WorkerUpdate[];
  /** Per worker, in order of first appearance. */
  threads: WorkerThread[];
  /** Injected into the running turn but not read by the lead yet. */
  pending?: boolean;
};
export type TeamChatRow = TeamActionRow | TeamUpdatesRow;

export function teamToolOp(toolName: string | null | undefined): TeamOp | null {
  const bare = toolName?.split('__').at(-1)?.split('.').at(-1) ?? '';
  return TEAM_TOOLS[bare] ?? null;
}

// ── tool rows ───────────────────────────────────────────────────────────────────────────────────

/** A string field out of possibly cut-off JSON: `{"worker":"a","message":"long…`. */
function jsonString(src: string, key: string): { value: string; complete: boolean } | null {
  const m = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)("?)`).exec(src);
  if (!m) return null;
  const complete = m[2] === '"';
  const raw = complete ? m[1] : m[1].replace(/…$/, '').replace(/\\u?[0-9a-fA-F]{0,3}$/, '').replace(/\\$/, '');
  let value: string;
  try {
    value = JSON.parse(`"${raw}"`) as string;
  } catch {
    value = raw.replace(/\\(.)/g, '$1');
  }
  return { value, complete };
}

function jsonBool(src: string, key: string): boolean | undefined {
  const m = new RegExp(`"${key}":(true|false)`).exec(src);
  return m ? m[1] === 'true' : undefined;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function answersText(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null;
  const values = Object.values(v as Record<string, unknown>).filter((x): x is string => typeof x === 'string' && x.length > 0);
  return values.length > 0 ? values.join('\n\n') : null;
}

function fromInputObject(op: TeamOp, input: Record<string, unknown>): Omit<TeamActionView, 'op' | 'ts'> {
  const base = { partial: false, model: null, requestId: str(input.request_id) };
  switch (op) {
    case 'spawn': {
      const model = [str(input.backend), str(input.model)].filter(Boolean).join(' · ');
      return { ...base, worker: str(input.name), text: str(input.prompt), model: model || null };
    }
    case 'send': return { ...base, worker: str(input.worker), text: str(input.message) };
    case 'stop': return { ...base, worker: str(input.worker), text: null };
    case 'answer': {
      const approved = typeof input.approved === 'boolean' ? input.approved : undefined;
      return {
        ...base, worker: null,
        text: approved !== undefined ? str(input.feedback) : answersText(input.answers) ?? str(input.feedback),
        ...(approved !== undefined ? { approved } : {}),
      };
    }
  }
}

/** History rows: the capped summary the server kept of the call. */
function fromSummary(op: TeamOp, summary: string): Omit<TeamActionView, 'op' | 'ts'> {
  const s = summary.trim();
  const requestId = jsonString(s, 'request_id')?.value ?? null;
  const base = { model: null, requestId };
  if (op === 'spawn') {
    // The summary of a spawn is its prompt, whitespace collapsed; the name is not in it.
    if (!s.startsWith('{')) return { ...base, worker: null, text: s.replace(/…$/, '') || null, partial: s.endsWith('…') };
    const prompt = jsonString(s, 'prompt');
    return { ...base, worker: jsonString(s, 'name')?.value ?? null, text: prompt?.value || null, partial: !!prompt && !prompt.complete };
  }
  const worker = jsonString(s, 'worker');
  if (op === 'stop') {
    return { ...base, worker: worker?.complete ? worker.value : null, text: null, partial: false };
  }
  if (op === 'send') {
    const message = jsonString(s, 'message');
    return { ...base, worker: worker?.complete ? worker.value : null, text: message?.value || null, partial: !!message && !message.complete };
  }
  const approved = jsonBool(s, 'approved');
  const text = approved !== undefined
    ? jsonString(s, 'feedback')
    : (() => {
      // `"answers":{"<question>":"<answer>"` — usually cut inside the question already.
      const m = /"answers":\{"(?:[^"\\]|\\.)*":"/.exec(s);
      return m ? jsonString(`"a":"${s.slice(m.index + m[0].length)}`, 'a') : null;
    })();
  return {
    ...base, worker: null, text: text?.value || null, partial: !!text && !text.complete,
    ...(approved !== undefined ? { approved } : {}),
  };
}

/** The action a lead's worker-tool row performed; null for every other row (and `worker_list`). */
export function teamActionOf(m: TranscriptMessage): TeamActionView | null {
  if (m.type !== 'tool') return null;
  const op = m.teamAction?.op ?? teamToolOp(m.toolName);
  if (!op) return null;
  const ts = m.ts ?? null;
  const summary = m.toolInput ?? '';
  const t = m.teamAction;
  if (t) {
    // The request id is not part of the structured ref, but the summary of an answer starts with it.
    const requestId = op === 'answer' ? jsonString(summary, 'request_id')?.value ?? null : null;
    return {
      op, worker: t.worker ?? null, text: t.text ?? null, partial: false, model: t.model ?? null,
      ...(t.approved !== undefined ? { approved: t.approved } : {}),
      requestId, ts,
    };
  }
  const full = m.debug?.toolInput;
  const parsed = full && typeof full === 'object' ? fromInputObject(op, full as Record<string, unknown>) : fromSummary(op, summary);
  return { op, ...parsed, ts };
}

// ── worker messages ─────────────────────────────────────────────────────────────────────────────

const HEADER = /^\[Worker (\S+) · ([^·\]]+?)(?: · request_id=([^\s·\]]+))?(?: · [^\]]*)?\]$/;
const INSTRUCTION = /^(Answer with worker_answer\(|Approve or reject with worker_answer\(|The user may also answer on the worker's own card)/;

/** Plain text of a Markdown snippet, on one line — for clamped previews, not for reading. */
export function plainLine(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .split('\n')
    .map((l) => l.replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/, ''))
    .join(' ')
    .replace(/\*\*|__|`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function planTitle(body: string): string {
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  const heading = lines.find((l) => /^#{1,6}\s/.test(l));
  return plainLine(heading ?? lines[0] ?? '');
}

/** A worker's report or request, out of the text the lead received. Null when the header is not
 *  the one the server writes — the row then keeps its plain hint form. */
export function parseWorkerMessage(origin: SystemTurnOrigin, text: string, ts: string | null): WorkerUpdate | null {
  if (origin !== 'worker-result' && origin !== 'worker-question') return null;
  const lines = systemOriginBody(text).split('\n');
  const head = HEADER.exec(lines[0]?.trim() ?? '');
  if (!head) return null;
  const [, worker, what, requestId] = head;
  let rest = lines.slice(1);
  if (rest[0]?.startsWith('status ')) rest = rest.slice(1);
  if (origin === 'worker-result') {
    const body = rest.join('\n').trim();
    const status = what.trim();
    return {
      kind: 'report', worker, sessionId: null, body, line: plainLine(body), ts,
      ...(status === 'failed' || status === 'stopped' ? { outcome: status } : {}),
    };
  }
  const cut = rest.findIndex((l) => INSTRUCTION.test(l.trim()));
  if (cut >= 0) rest = rest.slice(0, cut);
  const question = what.trim() === 'question';
  if (question) {
    const body = rest.join('\n').trim();
    const first = rest.map((l) => l.trim()).find((l) => /^Q\d+:/.test(l)) ?? rest.find((l) => l.trim()) ?? '';
    return {
      kind: 'question', worker, sessionId: null, body, line: plainLine(first.replace(/^Q\d+:\s*/, '')), ts,
      ...(requestId ? { requestId } : {}),
    };
  }
  const body = rest.filter((l) => !l.startsWith('Plan file: ')).join('\n').trim();
  return {
    kind: 'plan', worker, sessionId: null, body, line: planTitle(body), ts,
    ...(requestId ? { requestId } : {}),
  };
}

/** A worker's routine update (a `worker-progress` row). */
export function progressUpdate(m: TranscriptMessage): WorkerUpdate {
  const body = (m.text ?? '').trim();
  return {
    kind: 'progress', worker: m.worker?.name ?? '', sessionId: m.worker?.sessionId ?? null,
    body, line: plainLine(body), ts: m.ts ?? null,
  };
}

// ── grouping ────────────────────────────────────────────────────────────────────────────────────

/** Rows the builder keeps that render nothing, so they do not end a run of worker traffic. */
function invisible(row: ChatRow): boolean {
  return row.kind === 'assistant' && !row.preview && !row.text.trim() && !row.attachments?.length && !row.decisions?.length;
}

/** The builder's team state: the open card (if the run is still unbroken) and every request seen so
 *  far, which a later answer is matched against. */
export interface TeamBuild {
  open: TeamUpdatesRow | null;
  requests: WorkerUpdate[];
}

export function createTeamBuild(): TeamBuild {
  return { open: null, requests: [] };
}

/** The card the next update joins: the last one, while nothing visible has come after it. */
function openCard(team: TeamBuild, rows: ChatRow[], pending: boolean): TeamUpdatesRow | null {
  const card = team.open;
  if (!card || !!card.pending !== pending) return null;
  const at = rows.lastIndexOf(card);
  if (at < 0) return null;
  for (let i = at + 1; i < rows.length; i++) if (!invisible(rows[i])) return null;
  return card;
}

export function addWorkerUpdate(team: TeamBuild, rows: ChatRow[], update: WorkerUpdate, pending = false): void {
  if (update.kind === 'question' || update.kind === 'plan') team.requests.push(update);
  const card = openCard(team, rows, pending);
  if (card) {
    card.updates.push(update);
    return;
  }
  const next: TeamUpdatesRow = {
    kind: 'team-updates', id: `${update.ts ?? ''}|${update.worker}`, updates: [update], threads: [],
    ...(pending ? { pending: true } : {}),
  };
  rows.push(next);
  team.open = next;
}

/** The request an answer answers: by id when both name it, else the oldest open request of the
 *  same kind from the same worker (or from anyone, when the worker is unknown too). */
function requestFor(team: TeamBuild, action: TeamActionView): WorkerUpdate | null {
  if (action.requestId) {
    const exact = team.requests.find((r) => r.requestId === action.requestId);
    if (exact) return exact;
  }
  const kind = action.approved === undefined ? 'question' : 'plan';
  return team.requests.find((r) => !r.answer && r.kind === kind && (!action.worker || r.worker === action.worker)) ?? null;
}

/**
 * Place a lead action. An answer to a request still in the open card folds into it; every other
 * action becomes a row of its own (returned for the caller to push after flushing its tool run).
 * `adjacent` is false when other tool calls sit between the request and the answer — the answer
 * then no longer directly follows it.
 */
export function placeTeamAction(team: TeamBuild, rows: ChatRow[], action: TeamActionView, adjacent: boolean): TeamActionRow | null {
  if (action.op === 'answer') {
    const target = requestFor(team, action);
    if (target) {
      target.answer = {
        ...(action.approved !== undefined ? { approved: action.approved } : {}),
        text: action.text, partial: action.partial, ts: action.ts,
      };
      const card = adjacent ? openCard(team, rows, false) : null;
      if (card?.updates.includes(target)) return null;
      return { kind: 'team-action', action: { ...action, worker: action.worker ?? target.worker } };
    }
  }
  return { kind: 'team-action', action };
}

/** Split every card into per-worker threads and mark each worker's last card. */
export function finishTeamRows(rows: ChatRow[]): void {
  const cards = rows.filter((r): r is TeamUpdatesRow => r.kind === 'team-updates');
  const last = new Map<string, TeamUpdatesRow>();
  for (const card of cards) {
    const threads = new Map<string, WorkerThread>();
    for (const u of card.updates) {
      const t = threads.get(u.worker);
      if (t) {
        t.updates.push(u);
        t.sessionId ??= u.sessionId;
      } else {
        threads.set(u.worker, { worker: u.worker, sessionId: u.sessionId, updates: [u], latest: false });
      }
      last.set(u.worker, card);
    }
    card.threads = [...threads.values()];
  }
  for (const [worker, card] of last) {
    const t = card.threads.find((x) => x.worker === worker);
    if (t) t.latest = true;
  }
}

/** A question or plan the lead has not answered in the transcript. */
export function openRequest(thread: WorkerThread): WorkerUpdate | null {
  for (let i = thread.updates.length - 1; i >= 0; i--) {
    const u = thread.updates[i];
    if ((u.kind === 'question' || u.kind === 'plan') && !u.answer) return u;
  }
  return null;
}

/** What a card counts: reports, and routine updates apart from them. Requests are named instead. */
export function updateCounts(updates: WorkerUpdate[]): { reports: number; routine: number } {
  let reports = 0;
  let routine = 0;
  for (const u of updates) {
    if (u.kind === 'report') reports += 1;
    else if (u.kind === 'progress') routine += 1;
  }
  return { reports, routine };
}

/** The update a collapsed card leads with: the latest that is not routine, else the latest. */
export function headlineUpdate(updates: WorkerUpdate[]): WorkerUpdate {
  for (let i = updates.length - 1; i >= 0; i--) {
    if (updates[i].kind !== 'progress') return updates[i];
  }
  return updates[updates.length - 1];
}
