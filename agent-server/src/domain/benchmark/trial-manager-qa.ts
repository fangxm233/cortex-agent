// input:  trial task/thread projections, clock and actor capabilities
// output: durable nearest-manager and direct-parent question exchanges
// pos:    Trial-local manager Q&A authority
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteSync } from '../../core/atomic-write.js';
import type { ActorCapability } from './capabilities.js';
import type { DeterministicClock } from './trial-clock.js';

export const QA_NO_TARGET = 'qa_no_target';
export const ANSWER_STALE = 'answer_stale';

export interface QaResult {
  success: boolean;
  message?: string;
}

export interface TrialQaThreadMetadata {
  taskId?: string | null;
  parentThreadId?: string | null;
  dispatchGeneration?: string | null;
  attemptId?: string | null;
  pendingMessages?: string[];
  pendingQuestions?: Array<{
    questionId: string;
    fromTaskId: string | null;
    question: string;
  }>;
}

export interface TrialQaThread {
  id: string;
  status: string;
  metadata?: TrialQaThreadMetadata | null;
}

export interface TrialQaThreadStore {
  get(id: string): TrialQaThread | null;
  getAll(): TrialQaThread[];
  mutate(id: string, update: (thread: TrialQaThread) => void): void | Promise<void>;
}

export interface TrialQaTaskReader {
  getById(id: string): { id: string; parent: string | null } | null;
}

export interface TrialQuestionRecord {
  questionId: string;
  trialId: string;
  askerThreadId: string;
  askerTaskId: string;
  askerDispatchGeneration: string;
  askerAttemptId: string;
  managerThreadId: string;
  managerTaskId: string;
  managerDispatchGeneration: string;
  managerAttemptId: string;
  question: string;
  answer: string | null;
  state: 'open' | 'answered' | 'consumed' | 'invalidated';
  createdAt: string;
  answeredAt: string | null;
}

export interface TrialManagerQaMailbox {
  ask(capability: ActorCapability, question: string): { questionId: string };
  deliver(questionId: string): Promise<void>;
  answer(capability: ActorCapability, questionId: string, answer: string): QaResult;
  poll(questionId: string): { found: boolean; answered: boolean; answer: string | null };
  openQuestions(trialId: string): TrialQuestionRecord[];
}

export interface TrialManagerQaInput {
  trialId: string;
  root: string;
  threads: TrialQaThreadStore;
  tasks: TrialQaTaskReader;
  clock: DeterministicClock;
  isTerminalStatus(status: string): boolean;
}

interface ManagerTarget {
  threadId: string;
  taskId: string;
  generation: string;
  attemptId: string;
}

class TrialQaError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'TrialQaError';
    this.reason = reason;
  }
}

function managerQuestionsPath(root: string): string {
  return path.join(root, 'manager-qa', 'questions.json');
}

function parentQuestionsPath(root: string): string {
  return path.join(root, 'manager-qa', 'parent-questions.json');
}

function readArray<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  if (!Array.isArray(value)) throw new Error(`Trial Q&A store is malformed: ${file}`);
  return value as T[];
}

function writeArray<T>(file: string, values: readonly T[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteSync(file, `${JSON.stringify(values, null, 2)}\n`);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function nextId(prefix: string, trialId: string, records: readonly unknown[]): string {
  return `${prefix}_${trialId}_${records.length + 1}`;
}

function liveThread(
  input: TrialManagerQaInput,
  capability: ActorCapability,
): TrialQaThread | null {
  const matches = input.threads.getAll().filter(thread => {
    const metadata = thread.metadata;
    return metadata?.taskId === capability.task_id
      && metadata.dispatchGeneration === capability.dispatch_generation
      && metadata.attemptId === capability.attempt_id
      && !input.isTerminalStatus(thread.status);
  });
  return matches.length === 1 ? matches[0] : null;
}

function targetFromThread(
  input: TrialManagerQaInput,
  thread: TrialQaThread,
): TrialQaThread | null {
  const explicit = thread.metadata?.parentThreadId;
  if (explicit) {
    const target = input.threads.get(explicit);
    return target && !input.isTerminalStatus(target.status) ? target : null;
  }
  const taskId = thread.metadata?.taskId;
  const parentId = taskId ? input.tasks.getById(taskId)?.parent : null;
  if (!parentId) return null;
  const matches = input.threads.getAll().filter(candidate => (
    candidate.metadata?.taskId === parentId && !input.isTerminalStatus(candidate.status)
  ));
  return matches.length === 1 ? matches[0] : null;
}

function targetIdentity(thread: TrialQaThread): ManagerTarget | null {
  const metadata = thread.metadata;
  if (!metadata?.taskId || !metadata.dispatchGeneration || !metadata.attemptId) return null;
  return {
    threadId: thread.id,
    taskId: metadata.taskId,
    generation: metadata.dispatchGeneration,
    attemptId: metadata.attemptId,
  };
}

function resolveTarget(
  input: TrialManagerQaInput,
  capability: ActorCapability,
): { asking: TrialQaThread; target: ManagerTarget } | null {
  if (capability.trial_id !== input.trialId) return null;
  const asking = liveThread(input, capability);
  if (!asking) return null;
  const manager = targetFromThread(input, asking);
  const target = manager ? targetIdentity(manager) : null;
  return target ? { asking, target } : null;
}

function buildRecord(
  input: TrialManagerQaInput,
  capability: ActorCapability,
  resolved: { asking: TrialQaThread; target: ManagerTarget },
  question: string,
  records: readonly TrialQuestionRecord[],
): TrialQuestionRecord {
  return {
    questionId: nextId('q', input.trialId, records),
    trialId: input.trialId,
    askerThreadId: resolved.asking.id,
    askerTaskId: capability.task_id,
    askerDispatchGeneration: capability.dispatch_generation,
    askerAttemptId: capability.attempt_id,
    managerThreadId: resolved.target.threadId,
    managerTaskId: resolved.target.taskId,
    managerDispatchGeneration: resolved.target.generation,
    managerAttemptId: resolved.target.attemptId,
    question,
    answer: null,
    state: 'open',
    createdAt: input.clock.nowDate().toISOString(),
    answeredAt: null,
  };
}

function questionNotice(record: TrialQuestionRecord): string {
  return [
    `[Subtask question] #${record.askerTaskId}`,
    `Question: ${record.question}`,
    `Answer with answer_subtask(question_id="${record.questionId}", answer="...")`,
  ].join('\n');
}

function pushQuestion(thread: TrialQaThread, record: TrialQuestionRecord): void {
  const metadata = thread.metadata ?? (thread.metadata = {});
  const messages = metadata.pendingMessages ?? (metadata.pendingMessages = []);
  messages.push(questionNotice(record));
  const questions = metadata.pendingQuestions ?? (metadata.pendingQuestions = []);
  questions.push({
    questionId: record.questionId,
    fromTaskId: record.askerTaskId,
    question: record.question,
  });
}

function acceptsManagerAnswer(
  input: TrialManagerQaInput,
  record: TrialQuestionRecord,
  capability: ActorCapability,
): boolean {
  if (record.state !== 'open' || record.trialId !== capability.trial_id) return false;
  if (record.managerTaskId !== capability.task_id) return false;
  if (record.managerDispatchGeneration !== capability.dispatch_generation) return false;
  if (record.managerAttemptId !== capability.attempt_id) return false;
  const manager = input.threads.get(record.managerThreadId);
  return manager !== null && !input.isTerminalStatus(manager.status)
    && targetIdentity(manager)?.taskId === record.managerTaskId;
}

function stale(): QaResult {
  return { success: false, message: ANSWER_STALE };
}

function requireQaAction(capability: ActorCapability, action: 'qa.ask' | 'qa.answer'): void {
  if (!capability.allowed_actions.has(action)) throw new TrialQaError(QA_NO_TARGET);
}

export function createTrialManagerQaMailbox(
  input: TrialManagerQaInput,
): TrialManagerQaMailbox {
  const file = managerQuestionsPath(input.root);
  return {
    ask(capability, question) {
      requireQaAction(capability, 'qa.ask');
      const resolved = resolveTarget(input, capability);
      if (!resolved) throw new TrialQaError(QA_NO_TARGET);
      const records = readArray<TrialQuestionRecord>(file);
      const record = buildRecord(input, capability, resolved, question, records);
      writeArray(file, [...records, record]);
      return { questionId: record.questionId };
    },
    async deliver(questionId) {
      const record = readArray<TrialQuestionRecord>(file)
        .find(candidate => candidate.questionId === questionId && candidate.state === 'open');
      if (!record) throw new TrialQaError(ANSWER_STALE);
      await input.threads.mutate(record.managerThreadId, thread => pushQuestion(thread, record));
    },
    answer(capability, questionId, answer) {
      if (!capability.allowed_actions.has('qa.answer')) return stale();
      const records = readArray<TrialQuestionRecord>(file);
      const record = records.find(candidate => candidate.questionId === questionId);
      if (!record || !acceptsManagerAnswer(input, record, capability)) return stale();
      record.answer = answer;
      record.answeredAt = input.clock.nowDate().toISOString();
      record.state = 'answered';
      writeArray(file, records);
      return { success: true };
    },
    poll(questionId) {
      const records = readArray<TrialQuestionRecord>(file);
      const record = records.find(candidate => candidate.questionId === questionId);
      if (!record || record.state === 'consumed' || record.state === 'invalidated') {
        return { found: false, answered: false, answer: null };
      }
      if (record.state === 'open') return { found: true, answered: false, answer: null };
      record.state = 'consumed';
      writeArray(file, records);
      return { found: true, answered: true, answer: record.answer };
    },
    openQuestions(trialId) {
      return readArray<TrialQuestionRecord>(file)
        .filter(record => record.trialId === trialId && record.state !== 'consumed')
        .map(clone);
    },
  };
}

export interface ParentQuestion {
  questionId: string;
  trialId: string;
  taskId: string;
  attemptId: string;
  dispatchGeneration: string;
  question: string;
  answer: string | null;
  state: 'open' | 'answered' | 'consumed' | 'invalidated';
  createdAt: string;
  answeredAt: string | null;
}

export interface ParentAnswerInput {
  questionId: string;
  attemptId: string;
  answer: string;
}

export interface NeedsParentAnswer {
  questionId: string;
  attemptId: string;
  question: string;
}

export interface TrialParentQuestionBridge {
  record(capability: ActorCapability, question: string): ParentQuestion;
  resolveOuterCall(questionId: string): NeedsParentAnswer;
  accept(input: ParentAnswerInput): QaResult;
  poll(questionId: string): { found: boolean; answered: boolean; answer: string | null };
  invalidate(attemptId: string): void;
  open(): ParentQuestion[];
}

export interface ParentQuestionBridgeInput {
  trialId: string;
  root: string;
  clock: DeterministicClock;
  maxQuestions: number;
}

function parentRecord(
  input: ParentQuestionBridgeInput,
  capability: ActorCapability,
  question: string,
  records: readonly ParentQuestion[],
): ParentQuestion {
  return {
    questionId: nextId('pq', input.trialId, records),
    trialId: input.trialId,
    taskId: capability.task_id,
    attemptId: capability.attempt_id,
    dispatchGeneration: capability.dispatch_generation,
    question,
    answer: null,
    state: 'open',
    createdAt: input.clock.nowDate().toISOString(),
    answeredAt: null,
  };
}

function findOpenParent(records: ParentQuestion[], questionId: string): ParentQuestion | null {
  return records.find(record => record.questionId === questionId && record.state === 'open') ?? null;
}

export function createTrialParentQuestionBridge(
  input: ParentQuestionBridgeInput,
): TrialParentQuestionBridge {
  const file = parentQuestionsPath(input.root);
  return {
    record(capability, question) {
      requireQaAction(capability, 'qa.ask');
      if (capability.trial_id !== input.trialId) throw new TrialQaError(QA_NO_TARGET);
      const records = readArray<ParentQuestion>(file);
      if (records.length >= input.maxQuestions) throw new TrialQaError(QA_NO_TARGET);
      const record = parentRecord(input, capability, question, records);
      writeArray(file, [...records, record]);
      return clone(record);
    },
    resolveOuterCall(questionId) {
      const record = findOpenParent(readArray<ParentQuestion>(file), questionId);
      if (!record) throw new TrialQaError(ANSWER_STALE);
      return { questionId: record.questionId, attemptId: record.attemptId, question: record.question };
    },
    accept(answer) {
      const records = readArray<ParentQuestion>(file);
      const record = findOpenParent(records, answer.questionId);
      if (!record || record.attemptId !== answer.attemptId) return stale();
      record.answer = answer.answer;
      record.answeredAt = input.clock.nowDate().toISOString();
      record.state = 'answered';
      writeArray(file, records);
      return { success: true };
    },
    poll(questionId) {
      const records = readArray<ParentQuestion>(file);
      const record = records.find(candidate => candidate.questionId === questionId);
      if (!record || record.state === 'consumed' || record.state === 'invalidated') {
        return { found: false, answered: false, answer: null };
      }
      if (record.state === 'open') return { found: true, answered: false, answer: null };
      record.state = 'consumed';
      writeArray(file, records);
      return { found: true, answered: true, answer: record.answer };
    },
    invalidate(attemptId) {
      const records = readArray<ParentQuestion>(file);
      for (const record of records) {
        if (record.attemptId === attemptId && record.state === 'open') record.state = 'invalidated';
      }
      writeArray(file, records);
    },
    open() {
      return readArray<ParentQuestion>(file)
        .filter(record => record.state === 'open' || record.state === 'answered')
        .map(clone);
    },
  };
}
