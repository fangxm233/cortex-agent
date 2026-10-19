import type { MetadataSession } from '@/features/session/metadata/SessionMetadata';
import type { SessionContextUsage, SessionInfo, TodoSnapshot } from '@cortex-agent/ui-contract';
import type { SlashSuggestion } from '@/features/session/composer/composer-slash';
import type { SessionWaitpoints } from '@/features/session/live/useSessionWaitpoints';
import type { ContextCompactAction } from '@/features/session/composer/ContextUsageControl';
import type { AskAnswerState, AskCardModel, PlanCardModel } from '@/features/session/interaction/interaction-vm';
import type { ChatRow } from '@/features/session/transcript/transcript-vm';
import type { SessionStatsRow } from '@/features/session/list/session-stats';
import type { ChatHeaderStatus, PendingAttachmentVM, SelectionSheetRow } from './m-chat-vm';
import type { MChatSelection } from './m-chat-selection';

export interface MChatInteractions {
  askState: (requestId: string) => AskAnswerState;
  onAskPick: (model: AskCardModel, label: string) => void;
  onAskToggle: (model: AskCardModel, label: string) => void;
  onAskConfirmMulti: (model: AskCardModel) => void;
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

export interface MChatViewProps {
  title: string;
  /** Team mode: the worker's lead, named before the title; tapping it opens the lead. */
  parent?: { title: string; onSelect: () => void } | null;
  /** Team mode: the lead's workers, as a capsule above the composer that opens the team sheet.
   *  `onOpenWorker` runs from that sheet, so it should replace the sheet's history entry. */
  workers?: SessionInfo[];
  onOpenWorker?: (sessionId: string) => void;
  /** Opens a worker from a team row in the transcript. Unlike `onOpenWorker` no sheet is open, so it
   *  should add a history entry: back returns to this lead. Falls back to `onOpenWorker`. */
  onOpenWorkerFromChat?: (sessionId: string) => void;
  /** The board this session is bound to: a capsule above the composer opens it full-screen. */
  boardId?: string | null;
  /** Opens a session from the board's live strip. */
  onOpenBoardSession?: (sessionId: string) => void;
  status: ChatHeaderStatus;
  rows: ChatRow[];
  /** The foreground turn is running (not merely held open by background work): the turn being
   *  written keeps its work log open. */
  live?: boolean;
  /** The turn ended but background work holds the session; the stream says so at its end. */
  backgroundRunning?: boolean;
  /** The session's history is still loading — the transcript window follows the tail until it lands. */
  loading?: boolean;
  transcriptError?: boolean;
  onRetryTranscript?: () => void;
  onBack: () => void;
  /** Null for a draft; omitted in metadata-free presentation previews. */
  metadataSession?: MetadataSession | null;
  /** Whole-session totals rows, already formatted. Absent ⇒ the ⋯ menu hides the entry. */
  sessionStatsRows?: SessionStatsRow[] | null;
  backendUuid: string | null;
  systemLines?: string[];
  interactions?: MChatInteractions;
  rejectBar?: MRejectBar;
  msgMenu?: MMsgMenu | null;
  /** Long-press on a bubble; present ⇒ the message edit affordances render. */
  onLongPress?: (rowIndex: number, anchorTop: number) => void;
  editing?: MEditMode | null;
  /** The open session ('' for a draft): keys the live stream and scopes the capsules above the composer. */
  sessionId?: string;
  todos?: TodoSnapshot | null;
  /** What this session is waiting on from outside Cortex, supplied by the screen. */
  waitpoints?: SessionWaitpoints | null;
  composerValue: string;
  onComposerChange: (value: string) => void;
  onSend: () => void;
  onCommands?: () => void;
  slashSuggestions?: SlashSuggestion[];
  onSlashPick?: (suggestion: SlashSuggestion) => void;
  sendEnabled: boolean;
  composerPlaceholder?: string;
  onStop?: () => void;
  stopEnabled?: boolean;
  /** Engine + environment: what the next turn will run. The view draws the chips and sheets off it. */
  selection: MChatSelection;
  /** A sheet row was tapped: send its change. */
  onPickSelection: (row: SelectionSheetRow) => void;
  contextUsage?: SessionContextUsage | null;
  contextUsageSupported?: boolean;
  contextCompactAction?: ContextCompactAction;
  attachments: PendingAttachmentVM[];
  onRemoveAttachment: (id: string) => void;
  onRetryAttachment: (id: string) => void;
  onAddFiles: (files: FileList) => void;
}
