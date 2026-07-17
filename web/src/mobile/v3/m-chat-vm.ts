// Pure view-model for the 1b 会话详情 chat surface (scheme-mobile.dc.html 1b/1m/1n/1o/1p). Maps the
// real DTOs (SessionInfo / SessionTranscript / ConfigProfiles) into the scheme's slot model; the view
// owns every px/hex/font. Real data is the only variable — a field with NO DTO source is deliberately
// omitted, never fabricated.
//
// HONEST-GAP NOTE (verified against agent-server/domain/ui-service/app-router.ts + ui-contract):
//   • per-session `$` cost — SessionInfo carries none → OMITTED from the header/status lines.
// Interaction cards (提问 5b / plan 审批 6a) are transcript entity rows — their models live in
// the SHARED features/workbench/interaction-vm (askCardModel/planCardModel + answer reducers);
// this module only contributes the header status line for a pending interaction.
import type { ConfigProfileEntry } from '@cortex-agent/ui-contract';

export interface ChatHeaderStatus {
  running: boolean;
  /**
   * Header status line, mirroring the web composer (Composer.tsx):
   *   • running          → `running · {elapsed} · {turns}` (cost is not known mid-turn)
   *   • idle after a turn → `idle · {elapsed} · {turns} · {cost}`
   *   • fresh / never-run → bare `idle`
   * `turns`/`cost` render as `—` when unknown.
   * A pending interaction overrides the whole line (interactionHeaderStatus, scheme §5/§6):
   *   • plan  → `计划待批 · 线程已暂停`
   *   • ask   → `等待你的回答 k/n · 线程已暂停`
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

/**
 * Header status line — real running snapshot+delta + real agent-turn count + current/last-turn elapsed
 * + last-run cost. Same progressive logic as the desktop composer: running shows time + turns; an
 * idle-after-a-turn session adds the finalized cost; a fresh/never-run session shows just `idle`.
 */
export function chatHeaderStatus(
  running: boolean,
  turns: number | null,
  elapsed: string,
  cost: number | null,
  hasRun: boolean,
): ChatHeaderStatus {
  const turnsText = turns == null ? DASH : `${turns} turns`;
  if (running) {
    return { running: true, tone: 'running', text: `running · ${elapsed} · ${turnsText}` };
  }
  if (!hasRun) {
    return { running: false, tone: 'idle', text: 'idle' };
  }
  const costText = cost == null ? DASH : fmtCost(cost);
  return { running: false, tone: 'idle', text: `idle · ${elapsed} · ${turnsText} · ${costText}` };
}

/**
 * Header status while a pending interaction blocks the thread (scheme-mobile 5a/5b/6a):
 * amber dot + `计划待批 · 线程已暂停` (plan) or `等待你的回答 k/n · 线程已暂停` (ask, k =
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
    return { running: false, tone: 'waiting', text: zh ? '计划待批 · 线程已暂停' : 'plan pending · thread paused' };
  }
  const counter = total > 1 ? ` ${Math.min(answered + 1, total)}/${total}` : '';
  return {
    running: false,
    tone: 'waiting',
    text: zh ? `等待你的回答${counter} · 线程已暂停` : `awaiting your answer${counter} · thread paused`,
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

/** Composer profile-chip label (scheme 1b L162): `name · model` (model falls back to backend). */
export function profileChipLabel(name: string, profiles: ConfigProfileEntry[]): string {
  const p = profiles.find((x) => x.name === name);
  const detail = p?.model ?? p?.backend ?? null;
  return detail ? `${name} · ${detail}` : name;
}

/** Sub-label for a profile row in the 1p sheet: `model · backend` (drops the missing half). */
export function profileSub(p: ConfigProfileEntry): string {
  const model = p.model ?? '';
  const backend = p.backend ?? '';
  if (model && backend) return `${model} · ${backend}`;
  return model || backend;
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
