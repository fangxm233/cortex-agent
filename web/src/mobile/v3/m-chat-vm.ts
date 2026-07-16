// Pure view-model for the 1b 会话详情 chat surface (scheme-mobile.dc.html 1b/1m/1n/1o/1p). Maps the
// real DTOs (SessionInfo / SessionTranscript / ConfigProfiles) into the scheme's slot model; the view
// owns every px/hex/font. Real data is the only variable — a field with NO DTO source is deliberately
// omitted, never fabricated.
//
// HONEST-GAP NOTE (verified against agent-server/domain/ui-service/app-router.ts + ui-contract):
//   • per-session `$` cost — SessionInfo carries none → OMITTED from the header/status lines.
//   • 1m agent-提问 (AskUserQuestion) and 1n Plan-审批 (ExitPlanMode) — the web tRPC contract has NO
//     interaction/question/plan procedure or DTO, and the desktop CenterChat renders no such card.
//     The card types + formatters below exist so the UI is built + tested (neutral fixtures), but the
//     container has no real per-session source to feed them, so they never render from live data.
import type { ConfigProfileEntry } from '@cortex-agent/ui-contract';

export interface ChatHeaderStatus {
  running: boolean;
  /**
   * Header status line, mirroring the web composer (Composer.tsx):
   *   • running          → `running · {elapsed} · {turns}` (cost is not known mid-turn)
   *   • idle after a turn → `idle · {elapsed} · {turns} · {cost}`
   *   • fresh / never-run → bare `idle`
   * `turns`/`cost` render as `—` when unknown.
   */
  text: string;
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
    return { running: true, text: `running · ${elapsed} · ${turnsText}` };
  }
  if (!hasRun) {
    return { running: false, text: 'idle' };
  }
  const costText = cost == null ? DASH : fmtCost(cost);
  return { running: false, text: `idle · ${elapsed} · ${turnsText} · ${costText}` };
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

/** `MM:SS` TTL label for a real question deadline (scheme 1m L683). Clamped at 0. */
export function formatTtl(secondsLeft: number): string {
  const s = Math.max(0, Math.floor(secondsLeft));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

// ── 1m agent-提问 card model (fed only from a REAL pending interaction — none in the contract today) ──
export interface AskQuestionOption {
  id: string;
  label: string;
  isDefault: boolean;
  /** Optional right-aligned meta, e.g. cost/time delta (scheme L688). Omitted when absent. */
  meta?: string;
}
export interface AskQuestionCardData {
  id: string;
  question: string;
  /** `MM:SS 后按默认继续` — present ONLY when the real interaction carries a deadline; else omitted. */
  ttlLabel: string | null;
  options: AskQuestionOption[];
  /** `来自 X` source path (scheme L691), e.g. `ablation-sweep › plan`. */
  source: string;
  /** `hook 已同步 Slack` footnote — only when real. */
  syncedNote?: string;
}
export interface AnsweredQuestionRow {
  id: string;
  /** `问题 → 选中答案` one-line summary (scheme L679). */
  summary: string;
  time?: string;
}

// ── 1n Plan-审批 card model (fed only from a REAL pending plan — none in the contract today) ──
export interface PlanStep {
  n: number;
  text: string;
  /** Per-step duration estimate (scheme L725) — only when real. */
  dur?: string;
}
export interface PlanCardData {
  title: string;
  /** `预估 $3.80 · ~55m` — present ONLY when the real plan carries an estimate; else omitted. */
  estimateLabel: string | null;
  steps: PlanStep[];
  /** Amber caveat line (scheme L729) — only when real. */
  note?: string;
  /** `批准写入 plans/…` footer path (scheme L735) — only when real. */
  writePath?: string;
}

// ── 1o attachment chip model (real upload state machine, ported from desktop Composer) ──
export type AttachmentStatus = 'pending' | 'uploading' | 'done' | 'error';
export interface PendingAttachmentVM {
  id: string;
  name: string;
  /** 0-100 upload progress (scheme L774). */
  progress: number;
  status: AttachmentStatus;
}
