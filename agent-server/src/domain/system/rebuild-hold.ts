// input:  entry/daemon-notice.ts (the supervisor's 'rebuild-hold' IPC message)
// output: isRebuildHeld() / rebuildHold() — the admission answer every turn starter asks —
//         plus refuseTurnForRebuild(), the one wording for a turn that was not admitted
// pos:    the one piece of supervisor-pushed state this process keeps. The daemon knows it is about
//         to rebuild and replace us; nothing inside the app can work that out on its own.
//
// Why a turn must not start under a hold: the app spawns the backend CLI as its own child and owns
// its stdout. When the supervisor SIGTERMs the app, that CLI keeps running (it is past the point of
// caring) and writes its answer into a pipe with no reader — a turn that is never delivered, never
// completes, and leaves the session showing "processing" forever. Refusing the turn up front turns
// a silent orphan into a message the person can resend.
//
// The hold EXPIRES. A daemon that dies mid-pipeline must not leave this process refusing work for
// the rest of its life, so every phase change renews a short lease and the absence of news
// eventually means "carry on".

import type { Destination, PlatformAdapter } from '@platform/index.js';
import { Icons } from '@core/icons.js';
import { t } from '@core/i18n.js';
import { emitSystemNotice } from './system-notice.js';

/** How long a single 'hold' message is trusted. The supervisor re-sends on every phase change, and
 *  the longest single phase (web build, or `npm install -g` rewriting the vendored closure) runs
 *  well inside this. Fails open by design. */
const HOLD_LEASE_MS = 5 * 60_000;

export interface RebuildHold {
  /** The pipeline step in flight ('web', 'install', 'restart'), when the supervisor named one. */
  phase: string | null;
  /** What triggered the rebuild, verbatim ('src change: core/foo.ts'). */
  reason: string | null;
  /** When this process first started holding, in epoch ms. */
  since: number;
}

interface HeldState extends RebuildHold {
  expiresAt: number;
}

let held: HeldState | null = null;

/** Apply a supervisor hold message. Renews the lease and keeps the original `since`, so the UI and
 *  the refusal text can say how long the app has been closed for business. */
export function holdNewTurns(p: { phase?: string | null; reason?: string | null; now?: number }): void {
  const now = p.now ?? Date.now();
  held = {
    phase: p.phase ?? null,
    reason: p.reason ?? null,
    since: held?.since ?? now,
    expiresAt: now + HOLD_LEASE_MS,
  };
}

/** Lift the hold (pipeline aborted, or finished without replacing this process). */
export function releaseNewTurnHold(): void {
  held = null;
}

/** The active hold, or null. Reading it is what expires a stale lease. */
export function rebuildHold(now = Date.now()): RebuildHold | null {
  if (!held) return null;
  if (now >= held.expiresAt) {
    held = null;
    return null;
  }
  const { phase, reason, since } = held;
  return { phase, reason, since };
}

/** True while new turns must be refused. */
export function isRebuildHeld(now = Date.now()): boolean {
  return rebuildHold(now) !== null;
}

/** Longest message excerpt carried into the dropped-message notice. Enough to recognise which
 *  message it was, short enough for a toast. */
const PREVIEW_CHARS = 160;

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return '(no text)';
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat;
}

/**
 * Tell whoever sent this message that it was not processed. Never throws — a refusal that fails to
 * be delivered must still leave the turn un-started.
 *
 * Two audiences, two channels. A person who just typed gets the answer where they typed it, and
 * nothing else: they are looking at that conversation. A callback (a finished background agent, a
 * woken thread, a resume) has no reader, so it becomes a warning-level system notice instead — that
 * is the difference between "the restart ate my subagent's report" and knowing which message to
 * re-drive. Either way the work itself is NOT re-queued: nothing here survives the restart.
 */
export async function refuseTurnForRebuild(p: {
  adapter: PlatformAdapter;
  channel: string;
  /** The refused message's text, for the notice. */
  text: string;
  /** True when a human is waiting on this message in `channel`. */
  interactive: boolean;
}): Promise<void> {
  const phase = rebuildHold()?.phase ?? 'restart';
  if (p.interactive) {
    const destination: Destination = { type: 'interactive-reply', conduit: p.channel, sessionId: '' };
    await p.adapter
      .postMessage(destination, { text: `${Icons.warning} ${t('startup.rebuildHold', { phase })}` })
      .catch(() => {});
    return;
  }
  await emitSystemNotice(p.adapter, {
    level: 'warning',
    title: 'Rebuild',
    text: t('startup.rebuildHoldDropped', { phase, channel: p.channel, preview: preview(p.text) }),
  }).catch(() => {});
}

/** Test hook: drop the hold between cases. */
export const _test = {
  reset(): void { held = null; },
};
