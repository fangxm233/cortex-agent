// The transcript view-model, split by concern: the live tail (live-message), unread user messages
// (pending-user), system-authored turns (system-origin), the turn clock and status resolution
// (turn-clock), the row model (chat-row) and the row builder (transcript-rows). Importers keep
// using this module.
export {
  liveToMessage, type LiveSessionMessage, type SubagentSpawnView,
} from './live-message';
export {
  applyDelivered, reconcilePendingUserMessages, type DeliveredEvent, type PendingUserMessage,
} from './pending-user';
export {
  systemOriginBody, systemOriginDisplay, systemOriginLabel, systemOriginSummary, type SystemTurnDisplay,
} from './system-origin';
export {
  currentTurnClock, resolveBackgroundRunning, resolveRunning, resolveTurns, turnClockElapsedMs, turnCount,
  type TurnClock,
} from './turn-clock';
export {
  assistantTurnCopyTargets, regenNoteIndexes, rewindStats, type ChatRow, type DebugToolDetail, type ToolCallEntry,
} from './chat-row';
export {
  buildTranscriptRows, capsDayDivider, messageTimeLabel, toolCallLabel, type BuildOpts,
} from './transcript-rows';
export {
  headlineUpdate, openRequest, updateCounts, type TeamActionRow, type TeamActionView, type TeamChatRow,
  type TeamUpdatesRow, type WorkerThread, type WorkerUpdate,
} from './team-rows';

// Compatibility exports; preview state is kept separate from the transcript row model.
export {
  applyAssistantDelta, endStreamingBlock, initialAssistantPreviewState,
  applyAssistantPreviewDelta, finalizeAssistantPreview,
  type StreamingBlock, type AssistantDeltaEvent, type AssistantPreviewState,
} from './assistant-preview';
