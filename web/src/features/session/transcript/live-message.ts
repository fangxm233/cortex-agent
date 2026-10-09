import type {
  AuthNoticeAction,
  ChatNoticeLevel,
  DecisionItem,
  NoticeAction,
  SystemTurnOrigin,
  TeamActionRef,
  TeamWorkerRef,
  TranscriptMessage,
} from '@cortex-agent/ui-contract';
import type { AttachmentMeta as Attachment } from '@/features/attachments/types';

// The live `session.message` tail and its mapping onto the fetched transcript's message shape.

export type SubagentSpawnView = NonNullable<TranscriptMessage['subagentSpawns']>[number];

export type TranscriptMessageWithSpawns = TranscriptMessage & {
  liveTail?: true;
};

/** A live `session.message` event payload (the tRPC subscribe UiEvent.payload for that event). */
export interface LiveSessionMessage {
  sessionId: string;
  /** `worker-progress`: a team worker's interim reply, shown in its lead's chat (see `worker`). */
  role: 'user' | 'assistant' | 'tool' | 'worker-progress';
  text: string;
  /** User messages only: Cortex authored this turn rather than a human. */
  systemOrigin?: SystemTurnOrigin;
  toolName?: string;
  toolInput?: string;
  toolDevice?: string;
  /** Lead worker-tool rows only: what the call did to which worker. */
  teamAction?: TeamActionRef;
  /** `worker-progress` rows only: the worker that sent it. */
  worker?: TeamWorkerRef;
  noticeLevel?: ChatNoticeLevel;
  noticeAction?: NoticeAction;
  authAction?: AuthNoticeAction;
  ts: string;
  /** Optional file attachments on user messages (15a). */
  attachments?: Attachment[];
  /** Agent-announced decisions (`send_decision`) carried by an assistant message. */
  decisions?: DecisionItem[];
  /** Native-subagent grouping key — see ChatRow's `subagent` variant. */
  subagentId?: string;
  subagentSpawns?: SubagentSpawnView[];
  subagentType?: string;
  subagentDescription?: string;
  subagentModel?: string;
  /** Terminal state reported by the backend for the subagent named by `subagentId`. Carries no
   *  prose — it corrects that block's status and produces no row of its own. */
  subagentEnded?: 'completed' | 'failed' | 'killed';
}

/** Map a live `session.message` event into a `TranscriptMessage` (same shape the fetched DTO uses).
 *  `elapsedMs` is null for live-tail messages — the backend derives real per-message elapsed at read
 *  time, so it reconciles when the transcript refetches after the stream settles. */
export function liveToMessage(m: LiveSessionMessage): TranscriptMessageWithSpawns {
  const isTool = m.role === 'tool';
  return {
    type: m.role,
    text: isTool ? null : (m.text ?? ''),
    toolName: isTool ? (m.toolName ?? '') : null,
    toolInput: isTool ? (m.toolInput ?? '') : null,
    ...(isTool && m.toolDevice ? { toolDevice: m.toolDevice } : {}),
    ...(isTool && m.teamAction ? { teamAction: m.teamAction } : {}),
    ...(m.role === 'worker-progress' && m.worker ? { worker: m.worker } : {}),
    ts: m.ts,
    elapsedMs: null,
    attachments: m.attachments,
    ...(m.systemOrigin ? { systemOrigin: m.systemOrigin } : {}),
    ...(m.decisions?.length ? { decisions: m.decisions } : {}),
    ...(m.noticeLevel ? { noticeLevel: m.noticeLevel } : {}),
    ...(m.noticeAction ? { noticeAction: m.noticeAction } : {}),
    ...(m.authAction ? { authAction: m.authAction } : {}),
    ...(m.subagentId ? { subagentId: m.subagentId } : {}),
    ...(m.subagentSpawns?.length ? { subagentSpawns: m.subagentSpawns } : {}),
    ...(m.subagentType ? { subagentType: m.subagentType } : {}),
    ...(m.subagentDescription ? { subagentDescription: m.subagentDescription } : {}),
    ...(m.subagentModel ? { subagentModel: m.subagentModel } : {}),
    ...(m.subagentEnded ? { subagentEnded: m.subagentEnded } : {}),
  };
}
