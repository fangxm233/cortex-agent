// input:  a channel that is waiting on a human's free-text reply (armed by whoever is waiting),
//         plus every message that reaches a conversation entry on that channel
// output: whether this message WAS that reply — `true` ⇒ it was consumed and must not open a turn
// pos:    orchestration LEAF. It imports nothing from `orchestration/` (only `core/` logging), and
//         that is the whole point: the DR-0016 human-answer backstop has to be testable at the one
//         place every entry into a session passes through (`AgentRunner._routeWithAdmission`)
//         WITHOUT that module importing `manager-qa`, which would close the
//         `agent-runner → manager-qa → thread-callback → session-gateway → agent-runner` cycle
//         (.dependency-cruiser.cjs `no-circular` is an error). So the interception point imports
//         this registry; the owner of the question (`manager-qa`) arms it. Neither knows the other.
import { createLogger } from '@core/log.js';

const log = createLogger('human-answer-backstop');

/**
 * Consume `text` as the awaited human reply; `true` ⇒ consumed, the caller short-circuits.
 *
 * Deliberately SYNCHRONOUS: `tryConsume` sits on the routing decision, which has to know right
 * there whether this message becomes a turn — it cannot hand back a promise and let the message
 * proceed in the meantime. The one handler that exists today (manager-qa's human escalation) is
 * synchronous for the same reason: it records the answer fact and returns.
 */
export type HumanAnswerHandler = (text: string) => boolean;

/** channel → the handler waiting on it. At most one: a newer arm replaces an older one, exactly
 *  as the `channel → questionId` index it replaced did. */
const armed = new Map<string, HumanAnswerHandler>();

/** Optional restore hook — see `setHumanAnswerRehydrator`. */
let rehydrator: (() => void) | null = null;

/**
 * Register a hook that re-arms from durable state. A process that lost its memory (daemon restart)
 * has no arms in this map, but the question it was waiting on may still be live on disk; without
 * this, the first human reply after a restart would sail through as a normal turn. The owner
 * registers its own lazy hydration here and this module calls it before every lookup (the owner's
 * hydration is expected to be idempotent and cheap after the first call).
 */
export function setHumanAnswerRehydrator(fn: () => void): void {
  rehydrator = fn;
}

function restore(): void {
  if (!rehydrator) return;
  try {
    rehydrator();
  } catch (error) {
    log.error(`human-answer rehydrate failed: ${(error as Error).message}`);
  }
}

/** Arm `channel`: the next human message there is handed to `handler` instead of opening a turn. */
export function arm(channel: string, handler: HumanAnswerHandler): void {
  armed.set(channel, handler);
}

/**
 * Disarm `channel`. Pass the handler that armed it to make this identity-guarded: when a newer
 * arm has already replaced yours, disarming is a no-op. Callers that answer an OLD question on a
 * channel that has since armed a NEW one depend on that (manager-qa test: "answering an older
 * question does not disarm a newer question on the same channel").
 */
export function disarm(channel: string, handler?: HumanAnswerHandler): void {
  if (handler && armed.get(channel) !== handler) return;
  armed.delete(channel);
}

/** Is anything waiting for a human reply on `channel`? */
export function isArmed(channel: string): boolean {
  restore();
  return armed.has(channel);
}

/**
 * Offer `text` to whatever is armed on `channel`. `true` ⇒ consumed as the reply; the caller must
 * short-circuit. A handler that throws is logged and treated as "not consumed" — a bug in the
 * waiter must not swallow a user's message.
 */
export function tryConsume(channel: string, text: string): boolean {
  restore();
  const handler = armed.get(channel);
  if (!handler) return false;
  try {
    return handler(text) === true;
  } catch (error) {
    log.error(`human-answer handler on ${channel} threw: ${(error as Error).message}`);
    return false;
  }
}

/** Test hook: drop every arm (the rehydrator, registered once at import time, is kept). */
export function _testResetHumanAnswerBackstop(): void {
  armed.clear();
}
