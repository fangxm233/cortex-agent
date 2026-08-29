// input:  Mobile chat rows, interaction models, composer state, and sheet actions
// output: Shared public contracts for the mobile chat presentation modules
// pos:    Mobile chat presentation type boundary
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { ReactNode } from 'react';
import type { SessionContextUsage, TodoSnapshot } from '@cortex-agent/ui-contract';
import type { SlashSuggestion } from '@/features/workbench/composer-slash';
import type { ContextCompactAction } from '@/features/workbench/ContextUsageControl';
import type { AskAnswerState, AskCardModel, PlanCardModel } from '@/features/workbench/interaction-vm';
import type { ChatRow } from '@/features/workbench/transcript-vm';
import type { TodoRailLanguage } from '@/features/workbench/TodoRail';
import type { MIntCopy } from './MInteractionCards';
import type { ChatHeaderStatus, PendingAttachmentVM, ProfileSheetItem } from './m-chat-vm';

export interface MChatCopy {
  composerPh: string;
  toolCallsUnit: string;
  menuRename: string;
  menuExport: string;
  menuArchive: string;
  menuSessionId: string;
  sessionIdTitle: string;
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
  rows: ChatRow[];
  copy: MChatCopy;
  onBack: () => void;
  moreOpen: boolean;
  onMoreToggle: () => void;
  onMoreClose: () => void;
  sessionIdOpen: boolean;
  onSessionIdOpen: () => void;
  onSessionIdClose: () => void;
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
  composerValue: string;
  onComposerChange: (value: string) => void;
  onSend: () => void;
  slashSuggestions?: SlashSuggestion[];
  onSlashPick?: (suggestion: SlashSuggestion) => void;
  sendEnabled: boolean;
  composerPlaceholder?: string;
  onStop?: () => void;
  stopEnabled?: boolean;
  profileChipLabel: string;
  onOpenProfile: () => void;
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
  profileSheet?: { items: ProfileSheetItem[]; onClose: () => void; onPick: (name: string) => void };
}
