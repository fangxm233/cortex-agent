import type {
  AuthNoticeAction,
  ChatNoticeLevel,
  DecisionItem,
  NoticeAction,
  SystemTurnOrigin,
  TranscriptInteractionDetail,
} from '@cortex-agent/ui-contract';
import type { AttachmentMeta as Attachment } from '@/features/attachments/types';
import type { ToolCallImage } from '@/features/session/composer/chat-content';
import { systemOriginDisplay } from './system-origin';
import type { BoardActionRow } from './board-rows';
import type { TeamChatRow } from './team-rows';

// The chat-row model the transcript builder produces, and the queries both streams run over it.

export interface DebugToolDetail {
  toolRef?: string;
  toolInput?: unknown;
  toolResult?: { content: string; isError: boolean };
  overCharacterThreshold?: true;
}

export interface ToolCallEntry {
  kind: string;
  input: string;
  /** A thought in an ordered tool run; input carries its markdown, not a tool argument. */
  thinking?: true;
  /** The images the call's result carried; absent for every other call. */
  images?: ToolCallImage[];
  debug?: DebugToolDetail;
}

export type ChatRow =
  | { kind: 'divider'; text: string }
  | { kind: 'thinking'; text: string; preview?: true }
  // `turnIndex` is the rewind anchor (sessions.rewind) — absent on live-tail rows (not editable
  // until the transcript reconciles). `edited` backs the「已编辑」badge + original-message card;
  // `ts` backs its HH:MM stamp. `pending` marks a message written to the backend but not yet read
  // by the model: it renders in dimmed ink, pinned below everything the agent is currently saying.
  // `systemOrigin` marks a turn Cortex authored rather than the human (a resume signal, a task or
  // thread callback, a subtask's question, a backgrounded agent's result). Such a row is NOT a
  // user bubble: the stream renders it as a one-line hint, it offers no copy/edit/rewind (there is
  // no human message to rewind to) and it raises no nav-rail mark.
  | { kind: 'user'; text: string; attachments?: Attachment[]; turnIndex?: number; ts?: string; edited?: { originalText: string; originalTs: string }; pending?: boolean; systemOrigin?: SystemTurnOrigin; debug?: { agentMessage: string } }
  // `count` is the number of calls. A run of consecutive calls splits wherever it switches between
  // calls whose result carried images and the rest — see `flushTools`.
  | { kind: 'tools'; count: number; calls: ToolCallEntry[] }
  // `attachments` carries agent-sent files (20a) — rendered as left-aligned file cards under the text.
  // `preview` marks the ONE row that is the block being written right now (the token-level
  // accumulation), as opposed to a message the backend has committed. `streaming` cannot express
  // this: the idle heuristic also flags the last COMPLETE assistant row for a couple of seconds
  // after the final event. Only a preview row is paced by the smooth reveal — pacing a settled
  // message would re-type text the reader has already seen and leave it animating past turn end.
  // `decisions` carries agent-announced decision cards (send_decision) — rendered as compact
  // expandable cards under the text, one per decision.
  | { kind: 'assistant'; text: string; streaming: boolean; ts?: string; attachments?: Attachment[]; decisions?: DecisionItem[]; preview?: true }
  | { kind: 'notice'; level: ChatNoticeLevel; text: string; noticeAction?: NoticeAction; authAction?: AuthNoticeAction }
  // `detail` carries the structured interaction entity (pending cards render actionable);
  // absent on legacy rows, which render the old subtype-driven summary.
  | { kind: 'interaction'; subtype: string; text: string; detail?: TranscriptInteractionDetail; ts?: string | null }
  // Everything one native subagent produced under a single `Agent`/`Task` call, collapsed into one
  // block so its working notes and tool calls stop interleaving with the main agent's. The block
  // sits exactly where the spawning call happened, and REPLACES that call's chip — the header says
  // what was asked for. `children` is an ordinary ChatRow list, rendered by the same renderer.
  // Explicit per-child lifecycle wins; only legacy histories use parent-turn heuristics.
  // `model` is what actually answered, not what was requested: the CLI ships no `subagent_model`,
  // so it comes off `message.model` of the subagent's own messages and is therefore null until the
  // subagent has said something — the anchor alone cannot know it.
  | { kind: 'subagent'; id: string; agentType: string | null; description: string | null;
      prompt: string | null; model: string | null; status: 'running' | 'done'; toolCount: number; children: ChatRow[];
      hasDetails?: boolean; detailMode?: 'lazy' }
  // Team mode, in a lead's chat: one lead action on a worker (spawn / send / answer / stop), lifted
  // out of the tool-chip run, and one card per consecutive run of worker traffic. See team-rows.
  | TeamChatRow
  // A board_open call: a card for a board it created, one line for one it attached to. See board-rows.
  | BoardActionRow;

/**
 * What an edit at `rowIndex` (a user row) would discard: the count of assistant replies and tool
 * calls after that row. Backs the「发送后回退其后 N 条回复 · M 次工具调用作废」line (desktop 23a)
 * and the mobile「将被回退 · N 条回复 · M 次工具调用」badge (7b).
 */
export function rewindStats(rows: ChatRow[], rowIndex: number): { replies: number; toolCalls: number } {
  let replies = 0;
  let toolCalls = 0;
  for (let i = rowIndex + 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.kind === 'assistant') replies++;
    else if (r.kind === 'tools') toolCalls += r.count;
    else if (r.kind === 'team-action' || r.kind === 'board-action') toolCalls += 1;
  }
  return { replies, toolCalls };
}

/** Row indexes carrying the「由编辑重新生成」footnote: the first assistant row after each edited
 *  user row (stops at the next user row). Shared by the desktop MessageStream + mobile MChatStream. */
export function regenNoteIndexes(rows: ChatRow[]): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.kind !== 'user' || !r.edited) continue;
    for (let j = i + 1; j < rows.length; j++) {
      const k = rows[j].kind;
      if (k === 'user') break;
      if (k === 'assistant') { out.add(j); break; }
    }
  }
  return out;
}

/**
 * Whole-turn assistant text, keyed by the final substantive row in that turn.
 *
 * A turn ends at the next HUMAN message only. System-authored user rows (a background agent's
 * result, a task callback, a resume signal — see systemOriginLabel) are the machine steering itself
 * and read as one quiet hint line, so ending the turn there stranded the copy button mid-answer:
 * the reader saw prose, a copy icon, then the hint line and more tool calls under it. The reply
 * between two human messages is one thing to copy, and its button belongs at the bottom of it.
 *
 * The key is always a row that renders the action — assistant / tools / notice / interaction /
 * subagent, and the system-authored hint row, which renders it precisely so it can be a turn's last
 * row: a turn that trails off into「后台代理结果」hints would otherwise keep its button above them,
 * stranded mid-answer again until the next assistant row pushed it down. Divider rows and real user
 * bubbles carry no copy affordance, so landing the key on one would hide the button entirely.
 */
export function assistantTurnCopyTargets(rows: ChatRow[]): Map<number, string> {
  const targets = new Map<number, string>();
  let texts: string[] = [];
  let tailIndex: number | null = null;
  const flush = (): void => {
    if (tailIndex != null) targets.set(tailIndex, texts.join('\n\n'));
    texts = [];
    tailIndex = null;
  };
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.kind === 'user') {
      // A lead's message to its worker opens a turn exactly like the human's own.
      if (!row.systemOrigin || systemOriginDisplay(row.systemOrigin) === 'bubble') {
        flush();
        continue;
      }
      // Part of the turn it lands in, and eligible to be its LAST row — the button belongs under
      // the whole reply, hint lines included.
      if (texts.length > 0) tailIndex = i;
      continue;
    }
    if (row.kind === 'assistant' && row.text.length > 0) texts.push(row.text);
    if (row.kind !== 'divider' && row.kind !== 'thinking' && texts.length > 0) tailIndex = i;
  }
  flush();
  return targets;
}
