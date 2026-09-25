// input:  tRPC core and procedure error shapes
// output: router, publicProcedure and createCallerFactory
// pos:    UI router foundation with credential-error redaction
// >>> Once updated, update this header and parent AGENTS.md <<<

import { initTRPC } from '@trpc/server';

/**
 * Keepalive for the SSE subscription that carries the whole UI's live state.
 *
 * tRPC ships BOTH halves of this off by default (`ping.enabled: false`, no `client` options), and
 * with both off the app's shared live stream sends literally nothing between events: a quiet
 * session is an open socket with zero bytes on it for minutes at a time. Every hop between a phone
 * and this server — Cloudflare's edge, a carrier NAT, a Wi-Fi/cellular handoff, a suspended
 * WebView — drops such a socket, and a drop that arrives as silence rather than as a FIN is
 * invisible to both sides. The client then believes it is still subscribed forever: chat text stops
 * streaming, a sent message never leaves its pending state (the `delivered` event never lands),
 * running dots freeze mid-turn, and nothing refetches, because every live surface is invalidated by
 * this stream and nothing else. Only a remount-driven refetch (navigating to another screen) shows
 * the truth. Observed on mobile 2026-09-14.
 *
 * So: the server pings, and tells the client how long a silence is allowed to last. The `client`
 * block is delivered in the SSE `connected` event, so already-installed clients pick it up on their
 * next connect with no rebuild — `httpSubscriptionLink` reads its inactivity timer from there and
 * re-opens the stream itself when the window passes with no traffic.
 *
 * Interval vs window: tRPC REFUSES a ping slower than the client's reconnect window (it would
 * reconnect on every quiet gap), so keep `intervalMs` well under `reconnectAfterInactivityMs`.
 * 15 s is under every idle timeout we cross (Cloudflare closes a stream after ~100 s of silence),
 * and 45 s gives a re-connecting or briefly-stalled stream two missed pings of slack before the
 * client tears it down and starts over.
 */
export const UI_SSE_KEEPALIVE = {
  ping: { enabled: true, intervalMs: 15_000 },
  client: { reconnectAfterInactivityMs: 45_000 },
} as const;

const t = initTRPC.create({
  sse: UI_SSE_KEEPALIVE,
  errorFormatter({ shape, path }) {
    if (path !== 'config.setPlatform') return shape;
    return { ...shape, message: 'Platform configuration request failed',
      data: { ...shape.data, stack: undefined } };
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const createCallerFactory = t.createCallerFactory;
