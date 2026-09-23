import type { ReactNode } from 'react';
import type { SessionContextUsage, TodoSnapshot } from '@cortex-agent/ui-contract';
import type { SlashSuggestion } from '@/features/workbench/composer-slash';
import type { SessionWaitpoints } from '@/features/workbench/useSessionWaitpoints';
import type { ContextCompactAction } from '@/features/workbench/ContextUsageControl';
import type { AskAnswerState, AskCardModel, PlanCardModel } from '@/features/workbench/interaction-vm';
import type { ChatRow } from '@/features/workbench/transcript-vm';
import type { SessionStatsRow } from '@/features/workbench/session-stats';
import type { TodoRailLanguage } from '@/features/workbench/TodoRail';
import type { MIntCopy } from './MInteractionCards';
import type {
  ChatHeaderStatus, PendingAttachmentVM, SelectionSheetRow, SelectionSheetVM,
} from './m-chat-vm';

export interface MChatCopy {
  composerPh: string;
  menuSessionId: string;
  menuSessionStats: string;
  sessionIdTitle: string;
  sessionStatsTitle: string;
  sessionStatsHint: string;
  cortexIdLabel: string;
  backendUuidLabel: string;
  copy: string;
  copied: string;
  attachCamera: string;
  attachLibrary: string;
  attachFile: string;
  attachBrowser: string;
  attachCommission: string;
  attachCommands: string;
  attachPlaceholder: string;
  profileTitle: string;
  profileSubtitle: string;
  profileCurrent: string;
  profileFooter: string;
  /** The environment sheet: its title, the "follow the host default" row and its sub-label, and
   *  the `{backend}` template for an agent only a new conversation could take. */
  selectionAgent: string;
  selectionAgentDefault: string;
  selectionAgentFollow: string;
  selectionAgentCrossBackend: string;
  /** Section headings and the "follow the profile" row of the engine sheet. */
  selectionModel: string;
  selectionThinking: string;
  /** Heading of the billing-route section (anthropic `plan` vs `api`). */
  selectionMode: string;
  selectionFollow: string;
  /** Root row that hands every override back to the profile at once. */
  selectionFollowAll: string;
  /** `{n}` / `{backend}` templates accounting for the rows the picker held back. */
  selectionHiddenModels: string;
  selectionHiddenProfiles: string;
  selectionHiddenNoProfile: string;
  selectionPending: string;
  lineUnit: string;
  charUnit: string;
}

export interface MChatInteractions {
  copy: MIntCopy;
  askState: (requestId: string) => AskAnswerState;
  onAskPick: (model: AskCardModel, label: string) => void;
  onAskToggle: (model: AskCardModel, label: string) => void;
  onAskConfirmMulti: (model: AskCardModel) => void;
  onAskCustom: (model: AskCardModel) => void;
  rejectingId: string | null;
  onApprove: (model: PlanCardModel) => void;
  onRejectStart: (model: PlanCardModel) => void;
  onOpenRead: (model: PlanCardModel) => void;
  onCancelResume?: () => void;
  resumeCancelled?: boolean;
}

export interface MRejectBar {
  title: string;
  chips: string[];
  onChipTap: (chip: string) => void;
  onCancel: () => void;
}

export interface MChatEditCopy {
  menuCopy: string;
  menuEdit: string;
  editingBadge: string;
  willRewind: (replies: number, toolCalls: number) => string;
  editBarTitle: string;
  edited: string;
  original: string;
  regenNote: string;
}

export interface MMsgMenu {
  rowIndex: number;
  anchorTop?: number | null;
  onCopy: () => void;
  onEdit?: () => void;
  editDisabled?: boolean;
  onClose: () => void;
}

export interface MEditMode {
  rowIndex: number;
  replies: number;
  toolCalls: number;
  onCancel: () => void;
}

export interface BrowserSheetItem {
  device: string | null;
  label: string;
  sub: string;
}

/** A commission-mode option: null is off, 'new' drills a fresh contract, anything else is an id. */
export interface CommissionSheetItem {
  value: string | null;
  label: string;
  sub: string;
}

export interface MChatViewProps {
  title: string;
  status: ChatHeaderStatus;
  /** Project the session belongs to; prefixes the header status line when known. */
  project?: string;
  rows: ChatRow[];
  copy: MChatCopy;
  onBack: () => void;
  moreOpen: boolean;
  onMoreToggle: () => void;
  onMoreClose: () => void;
  sessionIdOpen: boolean;
  onSessionIdOpen: () => void;
  onSessionIdClose: () => void;
  /** Whole-session totals rows, already formatted. Absent ⇒ the ⋯ menu hides the entry. */
  sessionStatsRows?: SessionStatsRow[] | null;
  sessionStatsOpen: boolean;
  onSessionStatsOpen: () => void;
  onSessionStatsClose: () => void;
  cortexId: string | null;
  backendUuid: string | null;
  inlineThreadCard?: ReactNode;
  systemLines?: string[];
  interactions?: MChatInteractions;
  rejectBar?: MRejectBar;
  editCopy?: MChatEditCopy;
  msgMenu?: MMsgMenu | null;
  onLongPress?: (rowIndex: number, anchorTop: number) => void;
  editing?: MEditMode | null;
  onShowOriginal?: (edited: { originalText: string; originalTs: string }) => void;
  originalSheet?: { text: string; onClose: () => void } | null;
  streamKey?: string;
  sessionId?: string;
  todos?: TodoSnapshot | null;
  todoLang?: TodoRailLanguage;
  /** What this session is waiting on from outside Cortex (WaitRail), supplied by the screen. */
  waitpoints?: SessionWaitpoints | null;
  composerValue: string;
  onComposerChange: (value: string) => void;
  onSend: () => void;
  slashSuggestions?: SlashSuggestion[];
  onSlashPick?: (suggestion: SlashSuggestion) => void;
  sendEnabled: boolean;
  composerPlaceholder?: string;
  onStop?: () => void;
  stopEnabled?: boolean;
  /** What the next turn will run: the model (or, with no model pinned, the profile name). */
  selectionChipLabel: string;
  /** The thinking level beside it, rendered muted and dropped first when the toolbar is short of
   *  width. Null when the selection has no level. */
  selectionChipSub?: string | null;
  onOpenSelection: () => void;
  /** The environment capsule: the agent this conversation runs in, or — `followingDefault` — the
   *  one it falls back to. Absent on a host with fewer than two agents: nothing to choose. */
  agentChip?: { label: string; followingDefault: boolean } | null;
  onOpenAgent?: () => void;
  agentSheet?: {
    rows: SelectionSheetRow[];
    title: string;
    onClose: () => void;
    onPick: (row: SelectionSheetRow) => void;
  };
  browserDevice?: string | null;
  onOpenBrowser?: () => void;
  browserSheet?: { items: BrowserSheetItem[]; title: string; onClose: () => void; onPick: (device: string | null) => void };
  /** Commission mode: the value on a draft, or on a live session what it was created with. `label`
   *  is the commission title once one has landed; a session still drilling has none. */
  commissionValue?: string | null;
  commissionLabel?: string | null;
  onOpenCommission?: () => void;
  commissionSheet?: { items: CommissionSheetItem[]; title: string; onClose: () => void; onPick: (value: string | null) => void };
  contextUsage?: SessionContextUsage | null;
  contextUsageSupported?: boolean;
  contextUsageLang?: 'en' | 'zh';
  contextCompactAction?: ContextCompactAction;
  contextUsageOpen: boolean;
  onContextUsageOpen: () => void;
  onContextUsageClose: () => void;
  attachments: PendingAttachmentVM[];
  onRemoveAttachment: (id: string) => void;
  onRetryAttachment: (id: string) => void;
  onPlus: () => void;
  attachMenuOpen: boolean;
  onAttachClose: () => void;
  onCamera: () => void;
  onLibrary: () => void;
  onFile: () => void;
  selectionSheet?: {
    vm: SelectionSheetVM;
    pending: boolean;
    onClose: () => void;
    onPick: (row: SelectionSheetRow) => void;
  };
}
