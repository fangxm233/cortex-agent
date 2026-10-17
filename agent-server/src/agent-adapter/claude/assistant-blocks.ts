import { createLogger } from '@core/log.js';
import { getSettings } from '@core/settings.js';
import type { ToolUseSubagent } from '../normalize/event-types.js';
import type { PendingTurn } from './turn-machine.js';
import {
  isPlanFilePath, setActivePlanFile, takeTextBlockId, takeThinkingBlockId,
  type StreamDeltaState,
} from './event-parser.js';

const log = createLogger('claude-bridge');

function handleToolBlock(turn: PendingTurn, block: any, sessionId: string, subagent?: ToolUseSubagent): void {
  if (block.name === 'Write' && isPlanFilePath(block.input?.file_path)) {
    turn.planFilePath = block.input.file_path;
    setActivePlanFile(sessionId, block.input.file_path);
  }
  if (block.name === 'EnterPlanMode') turn.enteredPlanMode = true;
  if (block.name === 'ExitPlanMode') turn.exitedPlanMode = true;
  try {
    turn.onToolUse?.(block.name || '?', block.input || {}, typeof block.id === 'string' ? block.id : '', subagent);
  } catch (error) {
    log.warn('onToolUse threw:', (error as Error).message);
  }
}

function handleTextBlock(
  turn: PendingTurn, data: any, block: any, state: StreamDeltaState, subagent?: ToolUseSubagent,
): void {
  if (!block.text) return;
  const model = typeof data.message?.model === 'string' ? data.message.model : null;
  // Child prose is complete and attributed, never the parent's answer or streamed text cursor.
  if (subagent) {
    turn.onAssistantMessage?.(block.text, undefined, model, subagent);
    return;
  }
  turn.finalOutput = block.text;
  if (block.text.length > (turn.longestOutput?.length || 0)) turn.longestOutput = block.text;
  const blockId = takeTextBlockId(state) ?? undefined;
  const streamedModel = state.messageId === data.message?.id ? state.model : null;
  turn.onAssistantMessage?.(block.text, blockId, model ?? streamedModel);
}

function handleThinkingBlock(turn: PendingTurn, block: any, state: StreamDeltaState, subagent?: ToolUseSubagent): void {
  if (subagent) return;
  // Consume even suppressed/empty blocks so a later complete event cannot adopt a stale id.
  const blockId = takeThinkingBlockId(state) ?? undefined;
  if (!getSettings().showThinking || typeof block.thinking !== 'string' || !block.thinking) return;
  turn.onAssistantThinking?.(block.thinking, blockId);
}

/** Complete blocks share turn accounting, but thinking never enters the answer/text callbacks. */
export function handleAssistantBlocks(
  turn: PendingTurn, data: any, state: StreamDeltaState, sessionId: string, subagent?: ToolUseSubagent,
): void {
  if (subagent) turn.subagentTurnCount += 1;
  else turn.turnCount += 1;
  const handlers: Record<string, (block: any) => void> = {
    tool_use: block => handleToolBlock(turn, block, sessionId, subagent),
    text: block => handleTextBlock(turn, data, block, state, subagent),
    thinking: block => handleThinkingBlock(turn, block, state, subagent),
  };
  for (const block of (data.message?.content || [])) handlers[block.type]?.(block);
  if (!subagent) turn.onProgress?.({ num_turns: turn.turnCount, total_cost_usd: null, duration_ms: null });
}
