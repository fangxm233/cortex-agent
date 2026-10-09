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
  /** stop only. */
  retire?: boolean;
}

/** The worker a `worker-progress` row came from. */
export interface TeamWorkerRef {
  name: string;
  sessionId: string;
}
