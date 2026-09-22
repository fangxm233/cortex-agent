import type {
  ConfigAgentEntry, ConfigProfileEntry, ModelCatalogSnapshot, SessionSelectionOverride,
  SessionTranscript,
} from '@cortex-agent/ui-contract';
import {
  agentChange, agentRowSub, buildAgentOptions, buildModeOptions, buildModelOptions,
  buildProfileOptions, buildThinkingOptions, clearAllChange, groupModelOptions, modeChange,
  modelChange, profileChange, selectionChipParts, selectionRootRows, thinkingChange,
  visibleModelOptions, visibleProfileOptions,
  type EffectiveSelection, type SelectionRootRow,
} from '@/features/workbench/selection-menu';
import type { SelectionChange } from '@/features/workbench/selected-session';
import {
  buildTranscriptRows,
  type ChatRow,
  type LiveSessionMessage,
  type PendingUserMessage,
} from '@/features/workbench/transcript-vm';
import { zhDivider } from '@/mobile/screens/mobile-session-vm';
import type { SessionRunStatus } from '@/features/workbench/session-run-status';
import type { AttachmentUploadStatus } from '@/features/attachments/types';
import { formatUsd } from '@/lib/format';

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

export interface ChatRunStatusCopy {
  foreground: string;
  background: string;
  idle: string;
  turnsUnit: string;
  /** "waiting on N signals" — the caller localizes it; this module holds no literals of its own. */
  waitingOn?: (n: number) => string;
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
  /** Armed waitpoints (SessionInfo.waitingOn). Appended, never substituted: an idle session that is
   *  waiting for a machine is still idle, but it must not read as "nothing is happening". Tone stays
   *  neutral — amber belongs to a pending user action alone. */
  waitingOn = 0,
): ChatHeaderStatus {
  const turnsText = turns == null ? DASH : `${turns} ${copy.turnsUnit}`;
  const label = status.phase === 'background'
    ? copy.background
    : status.phase === 'foreground'
      ? copy.foreground
      : copy.idle;
  const base = status.showMetrics
    ? [label, elapsed, turnsText, ...(status.showCost ? [cost == null ? DASH : formatUsd(cost)] : [])].join(' · ')
    : label;
  const text = waitingOn > 0 && copy.waitingOn ? `${base} · ${copy.waitingOn(waitingOn)}` : base;
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

/** Composer engine-chip label: what the next turn will run — the model, and the level if one is set.
 *  The parts come from the shared `selectionChipParts` so the mobile chip and the desktop one name
 *  the same run the same way; mobile draws them as one line because it has no room for two. */
export function selectionChipLabel(selection: EffectiveSelection): string {
  const { main, sub } = selectionChipParts(selection);
  return [main, sub].filter(Boolean).join(' · ');
}

/** Sub-label for a profile row in the 1p sheet: `model · thinking · backend`
 *  (drops any missing segment — a null thinking level is simply omitted). */
export function profileSub(p: ConfigProfileEntry): string {
  return [p.model, p.thinking, p.backend].filter(Boolean).join(' · ');
}

export interface SelectionSheetRow {
  /** Stable identity, also the test hook: `profile:<name>`, `agent:<name>`, `agent:default`,
   *  `model:<backend>:<provider>:<id>`, `model:follow`, `thinking:<level>`, `thinking:follow`,
   *  `mode:<mode>`, `mode:follow`, `selection:clear`. */
  id: string;
  label: string;
  sub: string | null;
  current: boolean;
  /** What to send if it is tapped. Null means the tap is a no-op (it is already running). */
  change: SelectionChange | null;
  /** Drawn, but not available to THIS conversation — an agent on the other backend. The sub says
   *  why; only the agent list has such rows. */
  disabled?: boolean;
}

export interface SelectionSheetSection {
  key: 'profile' | 'model' | 'thinking' | 'mode';
  title: string;
  rows: SelectionSheetRow[];
  /** One line accounting for the rows that were NOT drawn, when any were held back. */
  footer?: string;
}

/** What the sheet shows at its root and behind each drill row. `sections[0]` is always the profile
 *  list — the root's own list — and the rest are the panes `rootRows` open. */
export interface SelectionSheetVM {
  sections: SelectionSheetSection[];
  rootRows: SelectionRootRow[];
  /** The root's "hand everything back to the profile" row; absent when nothing is overridden. */
  clearRow: SelectionSheetRow | null;
}

export interface SelectionSheetCopy {
  profile: string;
  model: string;
  thinking: string;
  /** Heading of the billing-route section — only shown when the endpoint declares more than one. */
  mode: string;
  followProfile: string;
  followAll: string;
  /** `{n}` / `{backend}` templates for what the picker held back. */
  hiddenModels: string;
  hiddenProfiles: string;
  hiddenNoProfile: string;
}

/** The one line that replaces the rows the picker held back. */
function hiddenNote(template: string, count: number, backend?: string | null): string | null {
  if (count === 0) return null;
  return template.replace('{n}', String(count)).replace('{backend}', backend ?? '');
}

function joinNotes(...notes: Array<string | null>): string | undefined {
  const kept = notes.filter((note): note is string => note !== null);
  return kept.length > 0 ? kept.join(' · ') : undefined;
}

/**
 * The 1p engine sheet, in two levels: the ROOT is the profile list (a profile is the base — backend,
 * route, fallback chain — and switching one is the common move) plus one collapsed row per override,
 * each showing the value in force. Those rows open a pane: MODEL, THINKING and — where the endpoint
 * bills more than one way — ROUTE, each with a "follow the profile" row so a choice can be taken
 * back. Nothing unpickable is drawn; a footer says how many rows were held back and why.
 * Every row carries the change it produces, so the screen never re-derives the rule — it is the same
 * shared arithmetic the desktop menu runs (features/workbench/selection-menu).
 *
 * The ENVIRONMENT is not in here: which agent the conversation runs in is its own axis, with its own
 * chip and its own sheet (`buildAgentSheet`), the way the desktop composer splits them.
 */
export function buildSelectionSheet(input: {
  profiles: ConfigProfileEntry[];
  catalog: ModelCatalogSnapshot | null | undefined;
  effective: EffectiveSelection;
  override: SessionSelectionOverride | null;
  hasHistory: boolean;
  defaultProfile: string | null;
  copy: SelectionSheetCopy;
}): SelectionSheetVM {
  const { profiles, catalog, effective, override, hasHistory, defaultProfile, copy } = input;
  const profileEntry = profiles.find((entry) => entry.name === effective.profileName) ?? null;

  const profileOptions = visibleProfileOptions(buildProfileOptions(profiles, effective.profileName, {
    currentBackend: effective.backend, hasHistory,
  }));
  const profileRows: SelectionSheetRow[] = profileOptions.options.map((option) => ({
    id: `profile:${option.name}`,
    label: option.name,
    sub: option.sub,
    current: option.active,
    change: profileChange(profileOptions.options, effective, option.name),
  }));

  const modelOptions = visibleModelOptions(
    buildModelOptions(catalog, profiles, effective, { hasHistory, defaultProfile }),
  );
  const modelRows: SelectionSheetRow[] = [{
    id: 'model:follow',
    label: copy.followProfile,
    sub: profileEntry?.model ?? null,
    current: !effective.modelOverridden,
    change: modelChange(effective, override, null),
  }];
  for (const group of groupModelOptions(modelOptions.options, effective.backend)) {
    for (const option of group.options) {
      modelRows.push({
        id: `model:${option.backend}:${option.provider ?? ''}:${option.id}`,
        label: option.id,
        sub: group.group,
        current: option.active,
        change: modelChange(effective, override, option),
      });
    }
  }

  const thinkingOptions = buildThinkingOptions(catalog, effective);
  const thinkingRows: SelectionSheetRow[] = thinkingOptions.length === 0 ? [] : [
    {
      id: 'thinking:follow',
      label: copy.followProfile,
      sub: profileEntry?.thinking ?? null,
      current: !effective.thinkingOverridden,
      change: thinkingChange(effective, override, null),
    },
    ...thinkingOptions.map((option): SelectionSheetRow => ({
      id: `thinking:${option.level}`,
      label: option.level,
      sub: null,
      current: option.active,
      change: thinkingChange(effective, override, option.level),
    })),
  ];

  const modeOptions = buildModeOptions(catalog, effective);
  const modeRows: SelectionSheetRow[] = modeOptions.length === 0 ? [] : [
    {
      id: 'mode:follow',
      label: copy.followProfile,
      sub: profileEntry?.mode ?? null,
      current: !effective.modeOverridden,
      change: modeChange(effective, override, null),
    },
    ...modeOptions.map((option): SelectionSheetRow => ({
      id: `mode:${option.mode}`,
      label: option.mode,
      sub: null,
      current: option.active,
      change: modeChange(effective, override, option.mode),
    })),
  ];

  const profileFooter = joinNotes(
    hiddenNote(copy.hiddenProfiles, profileOptions.hidden, profileOptions.hiddenBackend),
  );
  const modelFooter = joinNotes(
    hiddenNote(copy.hiddenModels, modelOptions.hiddenCrossBackend, modelOptions.hiddenBackend),
    hiddenNote(copy.hiddenNoProfile, modelOptions.hiddenNoProfile),
  );
  const clear = clearAllChange(effective);

  return {
    sections: [
      { key: 'profile', title: copy.profile, rows: profileRows, ...(profileFooter ? { footer: profileFooter } : {}) },
      { key: 'model', title: copy.model, rows: modelRows, ...(modelFooter ? { footer: modelFooter } : {}) },
      ...(thinkingRows.length > 0
        ? [{ key: 'thinking' as const, title: copy.thinking, rows: thinkingRows }]
        : []),
      ...(modeRows.length > 0
        ? [{ key: 'mode' as const, title: copy.mode, rows: modeRows }]
        : []),
    ],
    rootRows: selectionRootRows(
      effective,
      { model: copy.model, thinking: copy.thinking, mode: copy.mode },
      { hasThinking: thinkingRows.length > 0, hasModes: modeRows.length > 0 },
    ),
    clearRow: clear
      ? { id: 'selection:clear', label: copy.followAll, sub: null, current: false, change: clear }
      : null,
  };
}

export interface AgentSheetCopy {
  /** The row that hands the conversation back to the host's default, and what that means. */
  agentDefault: string;
  agentFollowDefault: string;
  /** `{backend}` template for an agent only a new conversation could take. */
  agentCrossBackend: string;
}

/**
 * The environment sheet: one flat list, because an agent is a whole answer with nothing to refine
 * underneath it — a "follow the host default" row, then every template this host declares.
 *
 * Unlike the model list this one DRAWS what it cannot offer: a live conversation may not change
 * backend, so an agent pinning the other backend's profile is greyed with the backend named rather
 * than folded into a count. There are a handful of environments, and "exists, but needs a new
 * conversation" is the answer a user can act on. Same arithmetic as the desktop menu, so a tap and
 * a click cannot mean different things.
 */
export function buildAgentSheet(input: {
  agents: ConfigAgentEntry[];
  profiles: ConfigProfileEntry[];
  /** The agent this conversation runs in; null = whatever the host's default is. */
  agentName: string | null;
  currentBackend: string;
  hasHistory: boolean;
  copy: AgentSheetCopy;
}): SelectionSheetRow[] {
  const { agents, profiles, agentName, currentBackend, hasHistory, copy } = input;
  const options = buildAgentOptions(agents, profiles, { agentName, currentBackend, hasHistory });
  return [
    {
      id: 'agent:default',
      label: copy.agentDefault,
      sub: copy.agentFollowDefault,
      current: agentName === null,
      change: agentChange(options, agentName, null),
    },
    ...options.map((option): SelectionSheetRow => ({
      id: `agent:${option.name}`,
      label: option.name,
      sub: agentRowSub(option, copy.agentCrossBackend),
      current: option.active,
      change: agentChange(options, agentName, option.name),
      ...(option.disabled ? { disabled: true } : {}),
    })),
  ];
}

// ── 7a long-press action overlay placement ──
// The overlay covers the chat BODY frame (transcript + composer), which runs the full height of the
// screen because the header floats over it rather than sitting above it in flow. The band the menu
// must not cross is therefore the header pill's bottom edge, which only the DOM knows (its top is a
// safe-area inset) — callers measure it and pass it as `safeTop`; this constant is just the floor.
/** Minimum inset from the top of that frame the floated group may not cross. */
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
  /** Overlay-local y the group may not rise above — the floating header's bottom edge plus a gap. */
  safeTop?: number;
}

/** The effective top band: the measured header clearance, never below the bare minimum. */
export function msgMenuSafeTop(safeTop?: number): number {
  return Math.max(MSG_MENU_SAFE_TOP, safeTop ?? 0);
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
  const safeTop = msgMenuSafeTop(l.safeTop);
  const lowest = l.overlayHeight - MSG_MENU_SAFE_BOTTOM - l.groupHeight;
  if (l.anchorTop == null || lowest <= safeTop) return safeTop;
  return Math.max(safeTop, Math.min(l.anchorTop - l.overlayTop, lowest));
}

// ── 1o attachment chip projection over the shared upload state machine ──
export interface PendingAttachmentVM {
  id: string;
  name: string;
  /** 0-100 upload progress (scheme L774). */
  progress: number;
  status: AttachmentUploadStatus;
  /** 'image' | 'video' | 'file' — drives the tappable preview thumbnail on the composer chip. */
  type?: 'image' | 'video' | 'file';
  /** Local object URL for an image/video preview (thumbnail + tap-to-open lightbox). */
  previewUrl?: string;
}
