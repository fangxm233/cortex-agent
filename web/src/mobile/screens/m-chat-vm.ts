import type { ConfigAgentEntry, EngineSelection, SessionTranscript } from '@cortex-agent/ui-contract';
import {
  agentChange, agentRowSub, buildAgentOptions, groupModelOptions, modeChange,
  modelChange, selectionChipParts, thinkingChange,
  type ModelOption, type SelectionRootRow,
} from '@/features/session/list/selection-menu';
import type { SessionSelection } from '@/features/session/composer/useSessionSelection';
import type { SelectionChange } from '@/features/session/state/selected-session';
import {
  buildTranscriptRows, type ChatRow, type LiveSessionMessage, type PendingUserMessage,
} from '@/features/session/transcript/transcript-vm';
import { fmt, type Vocab } from '@/i18n';
import { dayDivider, type TimeLang } from '@/i18n/time-format';
import type { AttachmentUploadStatus } from '@/features/attachments/types';

/** Mobile projection of the shared transcript, including streaming and unread injected messages. */
export interface MobileChatRowOpts {
  streaming?: boolean;
  running?: boolean;
  streamingText?: string | null;
  thinkingText?: string | null;
  pendingUser?: PendingUserMessage[];
  stripScheduledPrefix?: boolean;
  lang?: TimeLang;
  now?: Date;
}

export function buildMobileChatRows(
  transcript: SessionTranscript,
  liveTail: LiveSessionMessage[],
  opts: MobileChatRowOpts = {},
): ChatRow[] {
  return buildTranscriptRows(transcript, liveTail, {
    streaming: opts.streaming,
    running: opts.running,
    streamingText: opts.streamingText,
    thinkingText: opts.thinkingText,
    pendingUser: opts.pendingUser,
    stripScheduledPrefix: opts.stripScheduledPrefix,
    formatDivider: (ts, now) => dayDivider(ts, now, opts.lang ?? 'en'),
    ...(opts.now ? { now: opts.now } : {}),
  });
}

export interface ChatHeaderStatus {
  running: boolean;
  text: string;
  /** Kept in the leaf so a ticking clock does not re-render the chat. */
  liveText?: (now: number) => string;
  tone: 'running' | 'idle' | 'waiting';
}

export function interactionHeaderStatus(
  kind: 'ask-user' | 'plan-approval',
  answered: number,
  total: number,
  L: Pick<Vocab, 'chatPlanPendingStatus' | 'chatAwaitingAnswerStatus'>,
): ChatHeaderStatus {
  if (kind === 'plan-approval') {
    return { running: false, tone: 'waiting', text: L.chatPlanPendingStatus };
  }
  const counter = total > 1 ? ` ${Math.min(answered + 1, total)}/${total}` : '';
  return { running: false, tone: 'waiting', text: fmt(L.chatAwaitingAnswerStatus, { counter }) };
}

/** Mobile draws the same model/thinking chip as desktop, on one line. */
export function selectionChipLabel(selection: EngineSelection): string {
  const { main, sub } = selectionChipParts(selection);
  return [main, sub].filter(Boolean).join(' · ');
}

export interface SelectionSheetRow {
  id: string;
  label: string;
  sub: string | null;
  current: boolean;
  change: SelectionChange | null;
  disabled?: boolean;
  /** Backend/provider heading for model and favorite rows. */
  group?: string;
  /** Model picks use the shared controller, including lazy route resolution. */
  modelOption?: ModelOption;
}

export interface SelectionSheetSection {
  key: 'favorites' | 'model' | 'thinking' | 'mode';
  title: string;
  rows: SelectionSheetRow[];
}

export interface SelectionSheetVM {
  sections: SelectionSheetSection[];
  rootRows: SelectionRootRow[];
}

export interface SelectionSheetCopy {
  favorites: string;
  model: string;
  thinking: string;
  mode: string;
  defaultThinking: string;
  crossBackend: string;
}

type SheetOptions = Pick<SessionSelection,
  'effective' | 'favoriteOptions' | 'modelGroups' | 'thinkingOptions' | 'modeOptions' | 'rootRows'>;

function modelRow(
  option: ModelOption, current: EngineSelection, copy: SelectionSheetCopy, favorite: boolean,
): SelectionSheetRow {
  const detail = favorite ? option.selection.thinking : null;
  return {
    id: `${favorite ? 'favorite' : 'model'}:${option.backend}:${option.provider ?? ''}:${option.id}`,
    label: option.id,
    sub: option.disabled ? copy.crossBackend.replace('{backend}', option.backend) : detail,
    group: `${option.backend}${option.provider ? ` · ${option.provider}` : ''}`,
    current: option.active,
    change: modelChange(current, option),
    disabled: option.disabled,
    modelOption: option,
  };
}

function detailSections(input: SheetOptions, copy: SelectionSheetCopy): SelectionSheetSection[] {
  const thinking: SelectionSheetSection = {
    key: 'thinking', title: copy.thinking,
    rows: input.thinkingOptions.map((option) => ({
      id: `thinking:${option.level ?? 'default'}`, label: option.level ?? copy.defaultThinking,
      sub: null, current: option.active, change: thinkingChange(input.effective, option.level),
    })),
  };
  const mode: SelectionSheetSection = {
    key: 'mode', title: copy.mode,
    rows: input.modeOptions.map((option) => ({
      id: `mode:${option.mode}`, label: option.mode, sub: null,
      current: option.active, change: modeChange(input.effective, option.mode),
    })),
  };
  return [thinking, mode].filter((section) => section.rows.length > 0);
}

/** Hook-computed options keep desktop and mobile selection policy identical. Favorites need no catalog. */
export function buildSelectionSheet(input: SheetOptions & { copy: SelectionSheetCopy }): SelectionSheetVM {
  const { effective, copy } = input;
  const favorites = groupModelOptions(input.favoriteOptions, effective.backend)
    .flatMap((group) => group.options.map((option) => modelRow(option, effective, copy, true)));
  const models = input.modelGroups
    .flatMap((group) => group.options.map((option) => modelRow(option, effective, copy, false)));
  return {
    sections: [
      { key: 'favorites', title: copy.favorites, rows: favorites },
      { key: 'model', title: copy.model, rows: models },
      ...detailSections(input, copy),
    ],
    rootRows: input.rootRows,
  };
}

export interface AgentSheetCopy {
  agentDefault: string;
  agentFollowDefault: string;
}

/** Environments are independent of the engine; all remain available in existing sessions. */
export function buildAgentSheet(input: {
  agents: ConfigAgentEntry[];
  agentName: string | null;
  copy: AgentSheetCopy;
}): SelectionSheetRow[] {
  const { agents, agentName, copy } = input;
  const options = buildAgentOptions(agents, { agentName });
  return [
    {
      id: 'agent:default', label: copy.agentDefault, sub: copy.agentFollowDefault,
      current: agentName === null, change: agentChange(options, agentName, null),
    },
    ...options.map((option): SelectionSheetRow => ({
      id: `agent:${option.name}`, label: option.name, sub: agentRowSub(option),
      current: option.active, change: agentChange(options, agentName, option.name),
    })),
  ];
}

/** Minimum clearance for the floating message menu; the DOM supplies header-stack clearance. */
export const MSG_MENU_SAFE_TOP = 12;
export const MSG_MENU_SAFE_BOTTOM = 16;

export interface MsgMenuLayout {
  anchorTop: number | null;
  overlayTop: number;
  overlayHeight: number;
  groupHeight: number;
  safeTop?: number;
}

export function msgMenuSafeTop(safeTop?: number): number {
  return Math.max(MSG_MENU_SAFE_TOP, safeTop ?? 0);
}

/** Keep the held bubble in place unless the header or bottom edge requires moving the menu. */
export function msgMenuGroupTop(l: MsgMenuLayout): number {
  const safeTop = msgMenuSafeTop(l.safeTop);
  const lowest = l.overlayHeight - MSG_MENU_SAFE_BOTTOM - l.groupHeight;
  if (l.anchorTop == null || lowest <= safeTop) return safeTop;
  return Math.max(safeTop, Math.min(l.anchorTop - l.overlayTop, lowest));
}

export interface PendingAttachmentVM {
  id: string;
  name: string;
  progress: number;
  status: AttachmentUploadStatus;
  type?: 'image' | 'video' | 'file';
  previewUrl?: string;
}
