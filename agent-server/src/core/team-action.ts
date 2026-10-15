// Team-mode vocabulary shared by the transcript, the live event stream and the chat surfaces: what
// a lead's worker tool call did, and which worker a progress row belongs to.

/** One lead action on a worker, carried by the tool row of `worker_spawn` / `worker_send` /
 *  `worker_answer` / `worker_stop` (any tool-name prefix). `worker_list` carries none. */
export interface TeamActionRef {
  op: 'spawn' | 'send' | 'answer' | 'stop';
  /** Worker name. For `answer`, resolved from the request id; null when it cannot be. */
  worker: string | null;
  /** spawn: the prompt; send: the message; answer: the answer text or plan feedback. Capped. */
  text?: string;
  /** spawn only: requested backend/model as given (absent = inherited). */
  model?: string;
  /** answer only: plan approvals carry true/false; question answers omit it. */
  approved?: boolean;
}

/** The worker a `worker-progress` row came from. */
export interface TeamWorkerRef {
  name: string;
  sessionId: string;
}

/** Lead text carried on a team action is cut here; the worker's own transcript keeps all of it. */
export const TEAM_ACTION_TEXT_MAX = 4000;

const TEAM_ACTION_OPS: Readonly<Record<string, TeamActionRef['op']>> = {
  worker_spawn: 'spawn', worker_send: 'send', worker_answer: 'answer', worker_stop: 'stop',
};

/** The worker tool a call names, whatever server prefix the backend put on it. */
export function teamActionOp(toolName: string): TeamActionRef['op'] | null {
  const raw = toolName.split('__').at(-1)?.split('.').at(-1) ?? toolName;
  return TEAM_ACTION_OPS[raw] ?? null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function capped(text: string): string | undefined {
  if (!text) return undefined;
  return text.length > TEAM_ACTION_TEXT_MAX ? `${text.slice(0, TEAM_ACTION_TEXT_MAX)}…` : text;
}

function answerText(input: Record<string, unknown>): string {
  if (typeof input.approved === 'boolean') return str(input.feedback);
  const answers = input.answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return '';
  const entries = Object.entries(answers as Record<string, unknown>).map(([q, a]) => [q, String(a ?? '').trim()]);
  if (entries.length === 1) return entries[0][1];
  return entries.map(([q, a]) => `${q}: ${a}`).join('\n');
}

/**
 * What a lead's worker tool call does, read off its input. `workerForRequest` names the worker
 * behind a `worker_answer` request id (null when it is not known). Null for any other tool,
 * including `worker_list`, which changes nothing.
 */
export function teamActionFromToolCall(
  toolName: string, input: unknown, workerForRequest: (requestId: string) => string | null,
): TeamActionRef | null {
  const op = teamActionOp(toolName);
  if (!op || !input || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  switch (op) {
    case 'spawn': {
      const text = capped(str(record.prompt));
      const model = str(record.model) || str(record.backend);
      return { op, worker: str(record.name) || null, ...(text ? { text } : {}), ...(model ? { model } : {}) };
    }
    case 'send': {
      const text = capped(str(record.message));
      return { op, worker: str(record.worker) || null, ...(text ? { text } : {}) };
    }
    case 'answer': {
      const requestId = str(record.request_id);
      const text = capped(answerText(record));
      return {
        op,
        worker: requestId ? workerForRequest(requestId) : null,
        ...(text ? { text } : {}),
        ...(typeof record.approved === 'boolean' ? { approved: record.approved } : {}),
      };
    }
    case 'stop':
      return { op, worker: str(record.worker) || null };
  }
}
