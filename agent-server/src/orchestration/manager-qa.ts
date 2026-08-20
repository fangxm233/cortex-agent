// input:  thread/task state, production topology ledger, Q&A webhooks
// output: durable manager ask/answer routing and one-shot polling
// pos:    Manager Q&A control channel and restart-safe evidence source
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { threadStore } from '@store/thread-repo.js';
import { scanAllTasks } from '@core/task-parser.js';
import { isTerminalStatus } from '@domain/threads/tree.js';
import { resumeManagerForQuestion, wakeSession } from './thread-callback.js';
import { createLogger } from '@core/log.js';
import {
  consumeProductionTopologyAnswer,
  readProductionTopologyFacts,
  recordProductionTopologyFact,
  type ProductionTopologyFact,
} from '@domain/tasks/production-topology-ledger.js';
import type { ThreadRecord } from '@core/types/thread-types.js';

const log = createLogger('manager-qa');

interface PendingQuestion {
  questionId: string;
  fromThreadId: string;
  fromTaskId: string | null;
  managerThreadId: string | null; // null when escalated to a human
  channel: string | null;         // human-escalation channel (null for manager target)
  awaitingHuman: boolean;
  project: string;
  question: string;
  answer: string | null;
  answerFactId: string | null;
  createdAt: number;
}

/** Central in-memory question store (daemon process). questionId → question. */
const questions = new Map<string, PendingQuestion>();
/** channel → questionId, for routing a human's free-text reply back to the right pending ask. */
const channelIndex = new Map<string, string>();

function disarmHumanBackstop(question: PendingQuestion): void {
  if (question.channel && channelIndex.get(question.channel) === question.questionId) {
    channelIndex.delete(question.channel);
  }
}

let hydrated = false;

/** Test hook: clear all in-memory Q&A state without reloading durable history. */
export function _testResetManagerQa(): void {
  questions.clear();
  channelIndex.clear();
  hydrated = true;
}

/** Test hook: model a daemon restart by dropping memory and enabling durable reload. */
export function _testSimulateManagerQaRestart(): void {
  questions.clear();
  channelIndex.clear();
  hydrated = false;
}

/** Minimal task shape the resolver needs (kept tiny so callers/tests can inject a reader). */
interface TaskLite { parent: string | null; origin_channel: string | null }

export interface ManagerQaDeps {
  /** Disk-fresh task lookup (defaults to scanAllTasks). Injected in tests to avoid disk. */
  readTask?: (project: string | null, taskId: string) => TaskLite | null;
  /** Resume a waiting manager so it can answer (defaults to resumeManagerForQuestion). */
  resume?: (managerThreadId: string) => void;
  /** Wake the origin agent session at the top of the tree, handing it the question (defaults to the
   *  shared wakeSession → agentRunner.route). Injected in tests to avoid spawning a real turn. */
  wakeOriginSession?: (channel: string, notice: string) => void | Promise<void>;
}

function defaultReadTask(project: string | null, taskId: string): TaskLite | null {
  try {
    const t = scanAllTasks(project ?? undefined).find((x) => x.id === taskId);
    return t ? { parent: t.parent ?? null, origin_channel: t.origin_channel ?? null } : null;
  } catch {
    return null;
  }
}

async function defaultWakeOriginSession(channel: string, notice: string): Promise<void> {
  await wakeSession(channel, notice, `askmgr_${Date.now().toString(36)}`);
}

function questionFromFact(
  fact: Extract<ProductionTopologyFact, { kind: 'question' }>,
): PendingQuestion {
  return {
    questionId: fact.question_id, fromThreadId: fact.asker_thread_id,
    fromTaskId: fact.asker_task_id, managerThreadId: fact.manager_thread_id,
    channel: fact.origin_channel, awaitingHuman: fact.manager_thread_id === null,
    project: fact.project, question: fact.question, answer: null, answerFactId: null,
    createdAt: Date.parse(fact.occurred_at),
  };
}

function applyAnswerFact(
  fact: Extract<ProductionTopologyFact, { kind: 'answer' }>,
): void {
  const question = questions.get(fact.question_id);
  if (!question) return;
  if (fact.consumed_at !== null) {
    questions.delete(fact.question_id);
    return;
  }
  question.answer = fact.answer;
  question.answerFactId = fact.fact_id;
}

function ensureQaHydrated(): void {
  if (hydrated) return;
  try {
    const facts = readProductionTopologyFacts({ kinds: ['question', 'answer'] });
    for (const fact of facts) {
      if (fact.kind === 'question') questions.set(fact.question_id, questionFromFact(fact));
      else if (fact.kind === 'answer') applyAnswerFact(fact);
    }
    for (const question of questions.values()) {
      if (question.awaitingHuman && question.channel && question.answer === null) {
        channelIndex.set(question.channel, question.questionId);
      }
    }
    hydrated = true;
  } catch (error) {
    log.error(`manager Q&A durable reload failed: ${(error as Error).message}`);
  }
}

function recordQuestionFact(question: PendingQuestion): void {
  recordProductionTopologyFact({
    project: question.project, kind: 'question', question_id: question.questionId,
    asker_thread_id: question.fromThreadId, asker_task_id: question.fromTaskId,
    manager_thread_id: question.managerThreadId, origin_channel: question.channel,
    question: question.question, projectable: question.managerThreadId !== null,
  });
}

function recordAnswerFact(question: PendingQuestion, answererThreadId: string | null): void {
  const fact = recordProductionTopologyFact({
    project: question.project, kind: 'answer', question_id: question.questionId,
    answerer_thread_id: answererThreadId, answerer_channel: question.channel,
    asker_thread_id: question.fromThreadId, answer: question.answer ?? '', consumed_at: null,
    projectable: question.managerThreadId !== null && answererThreadId !== null,
  });
  question.answerFactId = fact.fact_id;
}

/** Notice injected into the manager's pendingMessages — an AGENT-facing prompt (English, not i18n;
 *  mirrors the directives, which are not localized). Mirrors buildChildResultNotice's shape: states
 *  what is asked and how to respond. */
export function buildQuestionNotice(q: { questionId: string; fromTaskId: string | null; question: string }): string {
  const from = q.fromTaskId ? `subtask #${q.fromTaskId}` : 'a subtask';
  return [
    `[Subtask question] ${from} hit something unclear/contradictory while executing and is checking your planning intent (you are its manager):`,
    '',
    `Question: ${q.question}`,
    '',
    'Answer with the answer_subtask tool (after answering you automatically return to waiting on your subtasks):',
    `    answer_subtask(question_id="${q.questionId}", answer="<your answer>")`,
    'If you are also unsure (it concerns a higher-level planning intent), call ask_manager to ask your own manager, then answer this subtask once you have their reply.',
  ].join('\n');
}

/** Notice routed into the ORIGIN session at the top of the tree — woken as an AGENT (the dispatcher
 *  of this work is the nearest manager), so it is agent-facing English (not i18n), mirroring
 *  buildQuestionNotice. It must answer via answer_subtask, or consult the human and let their reply
 *  flow back through the backstop. A prose reply here is NOT delivered to the subtask. */
export function buildOriginSessionNotice(q: { questionId: string; fromTaskId: string | null; question: string }): string {
  const from = q.fromTaskId ? `subtask #${q.fromTaskId}` : 'a subtask';
  return [
    `[Subtask question — you dispatched this task] ${from} hit something unclear/contradictory while executing and is checking the planning intent of whoever set it in motion. There is no dispatched manager thread above it, so YOU (this session) are its nearest manager:`,
    '',
    `Question: ${q.question}`,
    '',
    'Resolve it one of two ways — a prose reply in this channel is NOT delivered to the subtask:',
    `1. If you can answer from your own context / the task spec / the repo, answer the subtask directly with the answer_subtask tool:`,
    `       answer_subtask(question_id="${q.questionId}", answer="<your answer>")`,
    '2. If you genuinely cannot and it needs the human who owns this work, ask the human in this channel — their next reply here is delivered to the subtask as the answer.',
  ].join('\n');
}

/** Resolve the manager thread to ask: prefer an explicit thread parent; otherwise walk the task
 *  tree (child task.parent → the live thread that owns that manager task). Returns null when no
 *  live manager exists (→ human escalation). */
function resolveManagerThread(thread: ThreadRecord, deps: ManagerQaDeps): string | null {
  const ptid = thread.metadata?.parentThreadId;
  if (ptid) {
    const p = threadStore.get(ptid);
    if (p && !isTerminalStatus(p.status)) return ptid;
  }
  const taskId = thread.metadata?.taskId;
  if (!taskId) return null;
  const project = thread.metadata?.taskProject ?? null;
  const childTask = (deps.readTask ?? defaultReadTask)(project, taskId);
  const managerTaskId = childTask?.parent ?? null;
  if (!managerTaskId) return null;
  const mgr = threadStore.getAll().find((t) => t.metadata?.taskId === managerTaskId && !isTerminalStatus(t.status));
  return mgr?.id ?? null;
}

/** Walk up the task tree from the asking thread's task to the nearest ancestor that carries an
 *  origin_channel — the human who set the work in motion. Used only when no manager thread exists. */
function findEscalationChannel(thread: ThreadRecord, deps: ManagerQaDeps): string | null {
  const read = deps.readTask ?? defaultReadTask;
  const project = thread.metadata?.taskProject ?? null;
  let taskId: string | null = thread.metadata?.taskId ?? null;
  let hops = 0;
  while (taskId && hops < 16) {
    const t = read(project, taskId);
    if (!t) break;
    if (t.origin_channel) return t.origin_channel;
    taskId = t.parent;
    hops++;
  }
  // No human conduit captured anywhere up the tree → nothing to escalate to. We deliberately do
  // NOT fall back to thread.channel: a dispatch thread's channel is often an unattended
  // project-report conduit, and silently posting a question there would block the subtask on an
  // answer that never comes.
  return null;
}

async function deliverToManager(managerThreadId: string, q: PendingQuestion, deps: ManagerQaDeps): Promise<void> {
  await threadStore.mutate(managerThreadId, (t) => {
    const m = (t.metadata ??= {});
    if (!Array.isArray(m.pendingMessages)) m.pendingMessages = [];
    if (m.pendingMessages.length >= 10) m.pendingMessages.shift();
    m.pendingMessages.push(buildQuestionNotice(q));
    if (!Array.isArray(m.pendingQuestions)) m.pendingQuestions = [];
    m.pendingQuestions.push({ questionId: q.questionId, fromTaskId: q.fromTaskId, question: q.question });
  });
  // Only a suspended manager needs waking; a running one will see the question in its own loop.
  const mgr = threadStore.get(managerThreadId);
  if (mgr?.status === 'waiting') (deps.resume ?? resumeManagerForQuestion)(managerThreadId);
}

export type AskResult =
  | { ok: true; questionId: string; target: 'manager'; managerThreadId: string }
  | { ok: true; questionId: string; target: 'human'; channel: string }
  | { ok: false; error: string };

function newQuestionId(): string {
  return `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function pendingQuestion(
  thread: ThreadRecord, question: string, managerThreadId: string | null, channel: string | null,
): PendingQuestion {
  return {
    questionId: newQuestionId(), fromThreadId: thread.id,
    fromTaskId: thread.metadata?.taskId ?? null, managerThreadId, channel,
    awaitingHuman: managerThreadId === null,
    project: thread.metadata?.taskProject ?? thread.projectId,
    question, answer: null, answerFactId: null, createdAt: Date.now(),
  };
}

function persistQuestion(question: PendingQuestion): string | null {
  questions.set(question.questionId, question);
  try {
    recordQuestionFact(question);
    return null;
  } catch (error) {
    questions.delete(question.questionId);
    return `question persistence failed: ${(error as Error).message}`;
  }
}

async function askLiveManager(
  thread: ThreadRecord, question: string, managerThreadId: string, deps: ManagerQaDeps,
): Promise<AskResult> {
  const record = pendingQuestion(thread, question, managerThreadId, null);
  const error = persistQuestion(record);
  if (error) return { ok: false, error };
  await deliverToManager(managerThreadId, record, deps);
  log.info(`ask_manager: ${thread.id} → manager ${managerThreadId} (${record.questionId})`);
  return { ok: true, questionId: record.questionId, target: 'manager', managerThreadId };
}

function askOrigin(
  thread: ThreadRecord, question: string, channel: string, deps: ManagerQaDeps,
): AskResult {
  const record = pendingQuestion(thread, question, null, channel);
  const error = persistQuestion(record);
  if (error) return { ok: false, error };
  channelIndex.set(channel, record.questionId);
  const wake = deps.wakeOriginSession ?? defaultWakeOriginSession;
  Promise.resolve(wake(channel, buildOriginSessionNotice(record))).catch((wakeError: Error) =>
    log.error(`ask_manager origin-wake on ${channel}: ${wakeError.message}`));
  log.info(`ask_manager: ${thread.id} → origin session on ${channel} (${record.questionId})`);
  return { ok: true, questionId: record.questionId, target: 'human', channel };
}

/** Register and route a subtask question to its nearest manager or origin session. */
export async function askManager(
  threadId: string, question: string, deps: ManagerQaDeps = {},
): Promise<AskResult> {
  ensureQaHydrated();
  const thread = threadStore.get(threadId);
  if (!thread) return { ok: false, error: 'calling thread not found (CORTEX_THREAD_ID stale?)' };
  const normalized = (question ?? '').trim();
  if (!normalized) return { ok: false, error: 'question must not be empty' };
  const managerThreadId = resolveManagerThread(thread, deps);
  if (managerThreadId) return askLiveManager(thread, normalized, managerThreadId, deps);
  const channel = findEscalationChannel(thread, deps);
  if (channel) return askOrigin(thread, normalized, channel, deps);
  return { ok: false, error: 'no manager and no origin channel to escalate to — use your best judgment, record the assumption, or call thread_abort with a diagnosis' };
}

/** Manager answers a subtask question. Records the answer and forces the manager back to waiting
 *  (pendingControl='wait') so it re-suspends on its still-live children at the next step boundary. */
export async function submitAnswer(
  questionId: string, answer: string, options: { answererThreadId?: string | null } = {},
): Promise<{ ok: boolean; error?: string }> {
  ensureQaHydrated();
  const rec = questions.get(questionId);
  if (!rec) return { ok: false, error: `unknown question ${questionId} (expired or already consumed)` };
  if (rec.answer === null) {
    rec.answer = answer ?? '';
    const answerer = options.answererThreadId === undefined
      ? rec.managerThreadId : options.answererThreadId;
    try { recordAnswerFact(rec, answerer); } catch (error) {
      rec.answer = null;
      return { ok: false, error: `answer persistence failed: ${(error as Error).message}` };
    }
  }
  disarmHumanBackstop(rec);
  if (rec.managerThreadId) {
    await threadStore.mutate(rec.managerThreadId, (t) => {
      const m = (t.metadata ??= {});
      if (Array.isArray(m.pendingQuestions)) m.pendingQuestions = m.pendingQuestions.filter((x) => x.questionId !== questionId);
      // Re-suspend after answering — unless a control intent is already queued (don't clobber it).
      if (!m.pendingControl) m.pendingControl = { action: 'wait' };
    });
  }
  log.info(`answer_subtask: ${questionId} answered`);
  return { ok: true };
}

/** Poll for an answer. Consumes the entry once an answer is present (one-shot read by the poller). */
export function getAnswer(questionId: string): { found: boolean; answered: boolean; answer: string | null } {
  ensureQaHydrated();
  const rec = questions.get(questionId);
  if (!rec) return { found: false, answered: false, answer: null };
  if (rec.answer !== null) {
    if (!rec.answerFactId) return { found: true, answered: false, answer: null };
    try {
      if (!consumeProductionTopologyAnswer(rec.answerFactId)) {
        throw new Error(`answer fact ${rec.answerFactId} not found`);
      }
    } catch (error) {
      log.error(`manager Q&A consume marker failed: ${(error as Error).message}`);
      return { found: true, answered: false, answer: null };
    }
    questions.delete(questionId);
    disarmHumanBackstop(rec);
    return { found: true, answered: true, answer: rec.answer };
  }
  return { found: true, answered: false, answer: null };
}

/** Interactive hook: if `channel` has a pending human-escalated question, consume this message as
 *  its answer and return true (the caller should then short-circuit normal turn handling). */
export function tryAnswerFromHuman(channel: string, text: string): boolean {
  ensureQaHydrated();
  const qid = channelIndex.get(channel);
  if (!qid) return false;
  const rec = questions.get(qid);
  if (!rec || !rec.awaitingHuman) { channelIndex.delete(channel); return false; }
  if (rec.answer !== null) {
    disarmHumanBackstop(rec);
    return false;
  }
  rec.answer = text ?? '';
  try { recordAnswerFact(rec, null); } catch (error) {
    rec.answer = null;
    log.error(`human manager-Q&A persistence failed: ${(error as Error).message}`);
    return false;
  }
  disarmHumanBackstop(rec);
  log.info(`ask_manager: human answered ${qid} on ${channel}`);
  return true;
}
