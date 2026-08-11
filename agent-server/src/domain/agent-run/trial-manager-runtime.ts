// input:  trial task-tree authority and admitted fake/real attempt runner
// output: completed, questioned, cancelled or failed manager lifecycle
// pos:    Standalone manager scheduling and action loop
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { z } from 'zod';
import type { Task } from '../../core/task-parser.js';
import type { ActorCapability } from '../benchmark/capabilities.js';
import type {
  NeedsParentAnswer, ParentAnswerInput, QaResult, TrialParentQuestionBridge,
} from '../benchmark/trial-manager-qa.js';
import type {
  TreeFinalizationEvidence, TrialAttemptEvidence, TrialTaskTreeCoordinator,
} from '../benchmark/trial-task-tree-coordinator.js';

const subtaskSchema = z.object({
  key: z.string().min(1),
  text: z.string().min(1),
  done_when: z.string().min(1),
  template: z.enum(['benchmark-manager', 'benchmark-coder-review']),
  why: z.string().optional(),
  depends_on: z.array(z.string().min(1)).optional(),
}).strict();

const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('decompose'), subtasks: z.array(subtaskSchema).min(1) }).strict(),
  z.object({ type: z.literal('accept'), task_id: z.string(), note: z.string() }).strict(),
  z.object({ type: z.literal('reject'), task_id: z.string(), note: z.string() }).strict(),
  z.object({ type: z.literal('wait') }).strict(),
  z.object({ type: z.literal('complete'), note: z.string() }).strict(),
  z.object({ type: z.literal('ask'), question: z.string().min(1) }).strict(),
  z.object({
    type: z.literal('answer'), question_id: z.string().min(1), answer: z.string().min(1),
  }).strict(),
]);

const managerOutputSchema = z.object({ actions: z.array(actionSchema).min(1) }).strict();
type ManagerAction = z.infer<typeof actionSchema>;

export interface ManagerChildContext {
  id: string;
  text: string;
  status: string;
  template: string;
  verdict: string;
  note: string;
  reworkRound: number;
}

export interface TrialManagerContext {
  taskId: string;
  artifact: string;
  rotation: number;
  parentAnswer: string | null;
  pendingQuestions: Array<{ questionId: string; fromTaskId: string; question: string }>;
  children: ManagerChildContext[];
}

export interface TrialManagerAttemptInput {
  task: Task;
  role: 'manager' | 'coder';
  capability: ActorCapability;
  attemptOrdinal: number;
  context: TrialManagerContext;
  signal: AbortSignal;
}

export interface TrialManagerAttemptResult {
  taskId: string;
  threadId: string;
  state: 'completed' | 'failed' | 'cancelled' | 'timeout';
  summary: string;
  manifestCommitted: boolean;
  quiescent: boolean;
  proposal: { kind: 'complete'; note: string } | { kind: 'block'; reason: string } | null;
}

export interface TrialManagerRuntimeInput {
  tree: TrialTaskTreeCoordinator;
  parentQuestions: TrialParentQuestionBridge;
  runAttempt(input: TrialManagerAttemptInput): Promise<TrialManagerAttemptResult>;
  signal: AbortSignal;
  rootTask: { text: string; doneWhen: string };
}

export type TrialManagerRuntimeState =
  | 'completed' | 'failed' | 'cancelled' | 'needs_parent_answer';

export interface TrialManagerRuntimeResult {
  state: TrialManagerRuntimeState;
  rootTaskId: string;
  attempts: TrialManagerAttemptResult[];
  taskAttempts: TrialAttemptEvidence[];
  parentQuestion: NeedsParentAnswer | null;
  finalization: TreeFinalizationEvidence;
}

export interface TrialManagerRuntime {
  run(): Promise<TrialManagerRuntimeResult>;
  answerParent(input: ParentAnswerInput): QaResult;
}

interface RuntimeContext {
  input: TrialManagerRuntimeInput;
  attempts: TrialManagerAttemptResult[];
  parentQuestion: NeedsParentAnswer | null;
  parentQuestionTaskId: string | null;
  resumeAnswers: Map<string, string>;
}

function managerContext(tree: TrialTaskTreeCoordinator, task: Task): TrialManagerContext {
  const snapshot = tree.snapshot();
  const manager = snapshot.managers[task.id];
  const children = snapshot.tasks.filter(child => child.parent === task.id).map(child => {
    const acceptance = snapshot.acceptance[child.id];
    return {
      id: child.id, text: child.text, status: child.status, template: child.template,
      verdict: acceptance?.verdict ?? 'none', note: acceptance?.note ?? '',
      reworkRound: acceptance?.reworkRound ?? 0,
    };
  });
  return {
    taskId: task.id,
    artifact: manager?.artifact ?? '',
    rotation: manager?.rotations ?? 0,
    parentAnswer: tree.consumeParentAnswer(task.id),
    pendingQuestions: [...(manager?.pendingQuestions ?? [])],
    children,
  };
}

function resultFinish(result: TrialManagerAttemptResult) {
  const proposal = result.proposal;
  if (proposal?.kind === 'block') {
    return {
      kind: 'block' as const, note: proposal.reason, threadId: result.threadId,
      quiescent: result.quiescent, manifestCommitted: result.manifestCommitted,
    };
  }
  return {
    kind: 'complete' as const,
    note: proposal?.kind === 'complete' ? proposal.note : result.summary,
    threadId: result.threadId,
    quiescent: result.quiescent,
    manifestCommitted: result.manifestCommitted,
  };
}

function safeAttempt(result: TrialManagerAttemptResult): boolean {
  return result.state === 'completed' && result.manifestCommitted && result.quiescent;
}

function parseManagerActions(summary: string): ManagerAction[] {
  let value: unknown;
  try { value = JSON.parse(summary); }
  catch (error) { throw new Error(`Manager output is not JSON: ${(error as Error).message}`); }
  return managerOutputSchema.parse(value).actions;
}

async function applyDecompose(
  tree: TrialTaskTreeCoordinator,
  capability: ActorCapability,
  action: Extract<ManagerAction, { type: 'decompose' }>,
): Promise<void> {
  await tree.decompose(capability, action.subtasks.map(subtask => ({
    key: subtask.key,
    text: subtask.text,
    doneWhen: subtask.done_when,
    template: subtask.template,
    why: subtask.why,
    dependsOn: subtask.depends_on,
  })));
}

async function applyVerdict(
  tree: TrialTaskTreeCoordinator,
  capability: ActorCapability,
  action: Extract<ManagerAction, { type: 'accept' | 'reject' }>,
): Promise<void> {
  await tree.recordVerdict(
    capability, action.task_id, action.type === 'accept' ? 'accepted' : 'rejected', action.note,
  );
}

function rootQuestion(
  context: RuntimeContext,
  capability: ActorCapability,
  question: string,
): void {
  const record = context.input.parentQuestions.record(capability, question);
  context.parentQuestion = context.input.parentQuestions.resolveOuterCall(record.questionId);
  context.parentQuestionTaskId = capability.task_id;
}

async function applyAction(
  context: RuntimeContext,
  capability: ActorCapability,
  action: ManagerAction,
): Promise<void> {
  const tree = context.input.tree;
  if (action.type === 'decompose') return applyDecompose(tree, capability, action);
  if (action.type === 'accept' || action.type === 'reject') {
    return applyVerdict(tree, capability, action);
  }
  if (action.type === 'wait') return tree.wait(capability);
  if (action.type === 'complete') return tree.completeManager(capability, action.note);
  if (action.type === 'answer') {
    return tree.answerManager(capability, action.question_id, action.answer);
  }
  if (capability.ancestry.length > 0) {
    await tree.askManager(capability, action.question);
    return;
  }
  rootQuestion(context, capability, action.question);
  await tree.wait(capability);
}

async function runManagerAttempt(
  context: RuntimeContext,
  task: Task,
): Promise<'continue' | 'failed' | 'question'> {
  const tree = context.input.tree;
  const attempt = await tree.startAttempt(task.id, 'manager');
  const result = await tree.withWriter(attempt.capability, () => context.input.runAttempt({
    task, role: 'manager', capability: attempt.capability, attemptOrdinal: attempt.ordinal,
    context: managerContext(tree, task), signal: context.input.signal,
  }));
  context.attempts.push(result);
  if (!safeAttempt(result)) {
    await tree.finishAttempt(attempt.capability, resultFinish(result));
    return 'failed';
  }
  await tree.checkpointManager(attempt.capability, result.summary);
  for (const action of parseManagerActions(result.summary)) {
    await applyAction(context, attempt.capability, action);
  }
  await tree.finishAttempt(attempt.capability, {
    ...resultFinish(result), kind: 'continue', note: result.summary,
  });
  return context.parentQuestion ? 'question' : 'continue';
}

async function runLeafAttempt(
  context: RuntimeContext,
  task: Task,
): Promise<'continue' | 'failed'> {
  const tree = context.input.tree;
  const attempt = await tree.startAttempt(task.id, 'coder');
  const result = await tree.withWriter(attempt.capability, () => context.input.runAttempt({
    task, role: 'coder', capability: attempt.capability, attemptOrdinal: attempt.ordinal,
    context: managerContext(tree, task), signal: context.input.signal,
  }));
  context.attempts.push(result);
  const accepted = await tree.finishAttempt(attempt.capability, resultFinish(result));
  return accepted && safeAttempt(result) ? 'continue' : 'failed';
}

function nextTask(tree: TrialTaskTreeCoordinator): Task | null {
  const tasks = tree.actionable();
  const manager = tasks.find(task => task.template === 'benchmark-manager');
  return manager ?? tasks[0] ?? null;
}

async function finalResult(
  context: RuntimeContext,
  state: TrialManagerRuntimeState,
  rootTaskId: string,
): Promise<TrialManagerRuntimeResult> {
  const terminal = state === 'completed' ? 'completed'
    : state === 'cancelled' ? 'cancelled' : 'failed';
  const finalization = await context.input.tree.finalize(terminal);
  return {
    state, rootTaskId, attempts: [...context.attempts],
    taskAttempts: context.input.tree.snapshot().attempts,
    parentQuestion: context.parentQuestion,
    finalization,
  };
}

async function canceledResult(
  context: RuntimeContext,
  rootTaskId: string,
): Promise<TrialManagerRuntimeResult> {
  if (context.parentQuestion) {
    context.input.parentQuestions.invalidate(context.parentQuestion.attemptId);
  }
  await context.input.tree.cancel('manager runtime cancelled');
  return finalResult(context, 'cancelled', rootTaskId);
}

async function installResumeAnswers(context: RuntimeContext): Promise<void> {
  if (context.resumeAnswers.size === 0) return;
  for (const [taskId, answer] of context.resumeAnswers) {
    await context.input.tree.setParentAnswer(taskId, answer);
    context.resumeAnswers.delete(taskId);
  }
  context.parentQuestion = null;
  context.parentQuestionTaskId = null;
}

function pendingResult(
  context: RuntimeContext,
  rootTaskId: string,
): TrialManagerRuntimeResult {
  const snapshot = context.input.tree.snapshot();
  return {
    state: 'needs_parent_answer', rootTaskId, attempts: [...context.attempts],
    taskAttempts: snapshot.attempts,
    parentQuestion: context.parentQuestion,
    finalization: {
      terminal: 'failed',
      rootCompleted: snapshot.tasks.find(row => row.id === rootTaskId)?.status === 'done',
      descendantsQuiescent: snapshot.attempts.every(attempt => attempt.quiescent),
      liveCapabilities: context.input.tree.capabilityRegistry().liveCount(),
      writer: snapshot.writer,
    },
  };
}

function hydrateParentQuestion(context: RuntimeContext): void {
  const records = context.input.parentQuestions.open();
  if (records.length === 0) return;
  if (records.length > 1) throw new Error('multiple unresolved parent questions');
  const record = records[0];
  context.parentQuestionTaskId = record.taskId;
  if (record.state === 'answered') {
    const answer = context.input.parentQuestions.poll(record.questionId);
    if (answer.answered && answer.answer !== null) {
      context.resumeAnswers.set(record.taskId, answer.answer);
    }
    return;
  }
  context.parentQuestion = context.input.parentQuestions.resolveOuterCall(record.questionId);
}

async function runLoop(context: RuntimeContext): Promise<TrialManagerRuntimeResult> {
  const root = await context.input.tree.initializeRoot(context.input.rootTask);
  await installResumeAnswers(context);
  if (context.parentQuestion) return pendingResult(context, root.id);
  for (let cycle = 0; cycle < 100; cycle += 1) {
    if (context.input.signal.aborted) return canceledResult(context, root.id);
    await context.input.tree.resumeReadyManagers();
    const task = nextTask(context.input.tree);
    if (!task) {
      const complete = context.input.tree.snapshot().tasks.find(row => row.id === root.id)?.status;
      return finalResult(context, complete === 'done' ? 'completed' : 'failed', root.id);
    }
    const outcome = task.template === 'benchmark-manager'
      ? await runManagerAttempt(context, task) : await runLeafAttempt(context, task);
    if (outcome === 'failed') return finalResult(context, 'failed', root.id);
    if (outcome === 'question') return pendingResult(context, root.id);
  }
  return finalResult(context, 'failed', root.id);
}

export function createTrialManagerRuntime(
  input: TrialManagerRuntimeInput,
): TrialManagerRuntime {
  const context: RuntimeContext = {
    input, attempts: [], parentQuestion: null, parentQuestionTaskId: null,
    resumeAnswers: new Map(),
  };
  hydrateParentQuestion(context);
  return {
    run: () => runLoop(context),
    answerParent(answer) {
      const record = input.parentQuestions.open().find(
        candidate => candidate.questionId === answer.questionId,
      );
      const result = input.parentQuestions.accept(answer);
      if (!result.success) return result;
      const polled = input.parentQuestions.poll(answer.questionId);
      if (!record || !polled.answered || polled.answer === null) {
        return { success: false, message: 'answer_stale' };
      }
      context.parentQuestionTaskId = record.taskId;
      context.resumeAnswers.set(record.taskId, polled.answer);
      return result;
    },
  };
}
