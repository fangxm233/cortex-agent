// input:  Session DTOs, shared run-status facts, and transcript/interaction view models
// output: Chat rows, localized status, profile labels, and attachment/menu placement
// pos:    Pure presentation logic for the mobile session chat
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import type { ConfigProfileEntry, SessionTranscript } from '@cortex-agent/ui-contract';
import {
  buildTranscriptRows,
  type ChatRow,
  type LiveSessionMessage,
  type PendingUserMessage,
} from '@/features/workbench/transcript-vm';
import { zhDivider } from '@/mobile/screens/mobile-session-vm';
import type { SessionRunStatus } from '@/features/workbench/session-run-status';

/** What the mobile chat's rows are built from beyond the fetched transcript + live tail. */
export interface MobileChatRowOpts {
  /** The session is actively producing output (the live-stream idle heuristic). */
  streaming?: boolean;
  /** The session is genuinely executing — decides whether a subagent block still reads as running.
   *  Unlike `streaming` this does not drop during a quiet gap inside a turn. */
  running?: boolean;
  /** Text accumulated for the assistant block being written right now (token-level streaming). */
  streamingText?: string | null;
  /** Messages written into the running turn's backend that the model has not read yet. */
  pendingUser?: PendingUserMessage[];
  /** Scheduled run (8d): strip the `[Scheduled Task]` prefix off the opening prompt bubble. */
  stripScheduledPrefix?: boolean;
  /** Injected clock for deterministic day-relative dividers. */
  now?: Date;
}

/**
 * The mobile chat's row list: the shared `buildTranscriptRows` with the mobile 今天/昨天 divider
 * vocabulary, and — the part that was missing — the block being written right now plus any message
 * the model has not read yet.
 *
 * Both come from the shared live-sync hook, which holds an injected message OUT of the ordered tail
 * until its delivered event lands (nothing the agent is currently emitting was produced with it).
 * A surface that does not pass `pendingUser` through therefore renders no row for it at all, and the
 * message a user sent mid-turn simply vanishes from send until consumption. Ordering is the shared
 * builder's: the preview sits after everything committed, and the unread messages sit below the
 * preview, in send order among themselves.
 */
export function buildMobileChatRows(
  transcript: SessionTranscript,
  liveTail: LiveSessionMessage[],
  opts: MobileChatRowOpts = {},
): ChatRow[] {
  return buildTranscriptRows(transcript, liveTail, {
    streaming: opts.streaming,
    running: opts.running,
    streamingText: opts.streamingText,
    pendingUser: opts.pendingUser,
    stripScheduledPrefix: opts.stripScheduledPrefix,
    formatDivider: zhDivider,
    ...(opts.now ? { now: opts.now } : {}),
  });
}

export interface ChatHeaderStatus {
  running: boolean;
  /**
   * Header status line, mirroring the desktop composer from shared locale-free status facts:
   *   • foreground/background → localized label + elapsed + turns (cost is not final mid-run)
   *   • idle after a turn     → localized idle + elapsed + turns + cost
   *   • fresh / never-run     → bare localized idle
   * `turns`/`cost` render as `—` when unknown.
   * A pending interaction overrides the whole line (interactionHeaderStatus, scheme §5/§6):
   *   • plan  → `计划待批 · Agent 已暂停`
   *   • ask   → `等待你的回答 k/n · Agent 已暂停`
   */
  text: string;
  /** Header dot: running = blue pulse · waiting = amber (pending interaction) · idle = grey. */
  tone: 'running' | 'idle' | 'waiting';
}

const DASH = '—';

/** `$0.42` — matches the web `formatCost` (right-panel-vm.ts). */
function fmtCost(v: number): string {
  return '$' + v.toFixed(2);
}

export interface ChatRunStatusCopy {
  foreground: string;
  background: string;
  idle: string;
  turnsUnit: string;
}

/**
 * Maps the shared locale-free session facts into mobile copy. The screen retains ownership of
 * interaction/browser priority while this formatter owns only the ordinary progressive run line.
 */
export function chatHeaderStatus(
  status: SessionRunStatus,
  turns: number | null,
  elapsed: string,
  cost: number | null,
  copy: ChatRunStatusCopy,
): ChatHeaderStatus {
  const turnsText = turns == null ? DASH : `${turns} ${copy.turnsUnit}`;
  const label = status.phase === 'background'
    ? copy.background
    : status.phase === 'foreground'
      ? copy.foreground
      : copy.idle;
  const text = status.showMetrics
    ? [label, elapsed, turnsText, ...(status.showCost ? [cost == null ? DASH : fmtCost(cost)] : [])].join(' · ')
    : label;
  return { running: status.active, tone: status.active ? 'running' : 'idle', text };
}

/**
 * Header status while a pending interaction blocks the active agent (scheme-mobile 5a/5b/6a):
 * amber dot + `计划待批 · Agent 已暂停` (plan) or `等待你的回答 k/n · Agent 已暂停` (ask, k =
 * current question 1-based; the counter is omitted for a single question).
 */
export function interactionHeaderStatus(
  kind: 'ask-user' | 'plan-approval',
  answered: number,
  total: number,
  lang: 'zh' | 'en',
): ChatHeaderStatus {
  const zh = lang === 'zh';
  if (kind === 'plan-approval') {
    return { running: false, tone: 'waiting', text: zh ? '计划待批 · Agent 已暂停' : 'plan pending · agent paused' };
  }
  const counter = total > 1 ? ` ${Math.min(answered + 1, total)}/${total}` : '';
  return {
    running: false,
    tone: 'waiting',
    text: zh ? `等待你的回答${counter} · Agent 已暂停` : `awaiting your answer${counter} · agent paused`,
  };
}

/** The session's effective profile: explicit session profile, else config default, else first, else —. */
export function effectiveProfileName(
  profileName: string | null | undefined,
  profiles: ConfigProfileEntry[],
  defaultProfile: string | null,
): string {
  return profileName ?? defaultProfile ?? profiles[0]?.name ?? '—';
}

/** Composer profile-chip label: the configured profile name only. */
export function profileChipLabel(name: string): string {
  return name;
}

/** Sub-label for a profile row in the 1p sheet: `model · thinking · backend`
 *  (drops any missing segment — a null thinking level is simply omitted). */
export function profileSub(p: ConfigProfileEntry): string {
  return [p.model, p.thinking, p.backend].filter(Boolean).join(' · ');
}

export interface ProfileSheetItem {
  name: string;
  sub: string;
  current: boolean;
}

/** 1p Profile sheet rows (scheme L824-843): every configured profile, `当前` on the active one. */
export function buildProfileSheetItems(profiles: ConfigProfileEntry[], current: string): ProfileSheetItem[] {
  return profiles.map((p) => ({ name: p.name, sub: profileSub(p), current: p.name === current }));
}

// ── 7a long-press action overlay placement ──
// The overlay covers the chat BODY frame (transcript + composer), not the header — the same region
// the 2b full-screen editor takes, which is why the band below needs no header/safe-area arithmetic.
/** Inset from the top of that frame the floated group may not cross. */
export const MSG_MENU_SAFE_TOP = 12;
/** Inset from the bottom of that frame — keeps the menu off the screen edge. */
export const MSG_MENU_SAFE_BOTTOM = 16;

export interface MsgMenuLayout {
  /** Viewport y of the held bubble's top edge; null when the press reported no anchor. */
  anchorTop: number | null;
  /** Viewport y of the overlay box (the chat screen root). */
  overlayTop: number;
  /** Height of that overlay box. */
  overlayHeight: number;
  /** Measured height of the floated group: bubble copy + timestamp + menu. */
  groupHeight: number;
}

/**
 * Where the floated group sits inside the overlay, in overlay-local px.
 *
 * The copy of the held bubble stays ON the bubble the finger is holding, the way the iOS context
 * menu lifts a row in place. It is pushed down only to clear the header, and lifted only as far as
 * the menu hanging under it needs to clear the bottom edge — so the message you are acting on never
 * appears somewhere other than where you pressed. A group too tall for the band at all pins to the
 * top instead of escaping upward off-screen (the copy carries its own height cap for that case).
 */
export function msgMenuGroupTop(l: MsgMenuLayout): number {
  const lowest = l.overlayHeight - MSG_MENU_SAFE_BOTTOM - l.groupHeight;
  if (l.anchorTop == null || lowest <= MSG_MENU_SAFE_TOP) return MSG_MENU_SAFE_TOP;
  return Math.max(MSG_MENU_SAFE_TOP, Math.min(l.anchorTop - l.overlayTop, lowest));
}

// ── 1o attachment chip model (real upload state machine, ported from desktop Composer) ──
export type AttachmentStatus = 'pending' | 'uploading' | 'done' | 'error';
export interface PendingAttachmentVM {
  id: string;
  name: string;
  /** 0-100 upload progress (scheme L774). */
  progress: number;
  status: AttachmentStatus;
  /** 'image' | 'video' | 'file' — drives the tappable preview thumbnail on the composer chip. */
  type?: 'image' | 'video' | 'file';
  /** Local object URL for an image/video preview (thumbnail + tap-to-open lightbox). */
  previewUrl?: string;
}
