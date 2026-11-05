// The starting state of a foreground turn: its transcript streams, empty bookkeeping, and the
// callbacks its caller passed.
import type { Writable } from 'stream';

/** The transcript streams `createTurnStreams` opens for one turn. */
export type TurnStreams = { rawStream: Writable; txtStream: Writable; pairKey: string | null; releaseCapture: (() => void) | null };

/** The bookkeeping a foreground turn starts from. */
export function freshTurnState(streams: TurnStreams) {
  return {
    resultData: null, planFilePath: null, enteredPlanMode: false, exitedPlanMode: false,
    finalOutput: null, longestOutput: null, turnCount: 0, subagentTurnCount: 0,
    capturePairKey: streams.pairKey, releaseCapture: streams.releaseCapture,
    rawStream: streams.rawStream, txtStream: streams.txtStream, killed: false,
  };
}

/** A foreground turn's callbacks: the ones the caller passed, null for the rest. */
export function foregroundCallbacks(options: any) {
  return {
    onProgress: options.onProgress || null,
    onAssistantMessage: options.onAssistantMessage || null,
    onAssistantDelta: options.onAssistantDelta || null,
    onAssistantThinking: options.onAssistantThinking || null,
    onAssistantThinkingDelta: options.onAssistantThinkingDelta || null,
    onToolUse: options.onToolUse || null,
    onToolResult: options.onToolResult || null,
    onCompact: options.onCompact || null,
    onModelFallback: options.onModelFallback || null,
    onApiRetry: options.onApiRetry || null,
    onContextUsage: options.onContextUsage || null,
    onSubagentActivity: options.onSubagentActivity || null,
    onSubagentEnd: options.onSubagentEnd || null,
  };
}
