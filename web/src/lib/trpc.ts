// input:  optional remote server config and transport policy
// output: tRPC client factory and React context
// pos:    Browser and native-app tRPC transport
// >>> Once updated, update this header and parent CORTEX.md <<<

// Browser clients use same-origin /trpc; native apps use the configured server URL and
// token. The subscription link supplies authentication through a fetch-based EventSource.

import { credentialSafeFetch } from './sensitive-transport';
import {
  createTRPCClient,
  httpBatchLink,
  httpSubscriptionLink,
  splitLink,
} from '@trpc/client';
import { createTRPCContext } from '@trpc/tanstack-react-query';
import type { AppRouter } from '@cortex-agent/ui-contract';
import { EventSource as ExtEventSource } from 'eventsource';
import type { EventSourceFetchInit } from 'eventsource';

// The real tRPC AppRouter (Stage-1 task 3) is used directly. The old forward-compat seam
// (`AppRouter extends AnyTRPCRouter ? AppRouter : AnyTRPCRouter`) was removed in task 5: a
// deferred conditional type does NOT auto-tighten — createTRPCContext widened it back to
// AnyTRPCRouter and every procedure degraded to `any`. Using AppRouter directly restores
// full end-to-end type inference (tasks.list → TaskInfo[], mutation inputs, etc.).
export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();

/**
 * Optional remote-mode config, injected by the desktop shell (e.g. Tauri).
 * When absent the client falls back to same-origin relative /trpc (browser/ui-http mode).
 */
export interface RemoteConfig {
  /** Absolute base URL of the agent-server, e.g. https://cortex.example.com */
  serverUrl: string;
  /** Static bearer token sent as x-cortex-token on every request. */
  token: string;
}

/**
 * Computes the base tRPC URL from optional remote config.
 * Desktop/remote: absolute `${serverUrl}/trpc`.
 * Browser/ui-http: relative `/trpc` (same-origin; Vite dev proxy in dev).
 */
export function trpcUrl(config?: RemoteConfig): string {
  return config ? `${config.serverUrl}/trpc` : '/trpc';
}

/**
 * Returns HTTP headers for httpBatchLink.
 * Desktop mode: carries the x-cortex-token bearer.
 * Browser mode: empty object — proxy or same-origin server handles auth.
 */
export function buildBatchHeaders(config?: RemoteConfig): Record<string, string> {
  return config ? { 'x-cortex-token': config.token } : {};
}

/**
 * Returns a custom fetch function for the EventSource ponyfill (desktop mode only).
 * Merges x-cortex-token into every SSE request header set so the SSE stream is
 * authenticated when connecting cross-origin. The native browser EventSource cannot
 * set custom headers; the `eventsource` npm package (fetch-based) accepts a custom
 * fetch that can.
 */
export function buildSseFetch(
  token: string,
): (url: string | URL, init: EventSourceFetchInit) => Promise<Response> {
  return (url: string | URL, init: EventSourceFetchInit) =>
    fetch(url as RequestInfo, {
      signal: init.signal as AbortSignal | null,
      headers: { ...init.headers, 'x-cortex-token': token },
      mode: init.mode,
      credentials: init.credentials,
      cache: init.cache,
      redirect: init.redirect,
    });
}

/**
 * Creates a tRPC client configured for one of two modes:
 *
 *  **Browser / ui-http (no config):**
 *    Relative /trpc URL, no explicit headers — identical to the previous behaviour.
 *    The Vite dev proxy or same-origin ui-http-server injects x-cortex-token.
 *    Native EventSource for SSE (same-origin, no header needed).
 *
 *  **Desktop / remote (config injected by Tauri shell):**
 *    Absolute ${serverUrl}/trpc URL.
 *    httpBatchLink sends x-cortex-token in request headers.
 *    httpSubscriptionLink uses the `eventsource` fetch-based ponyfill with a custom
 *    fetch that merges x-cortex-token into every SSE request.
 */
export function createTrpcClient(config?: RemoteConfig) {
  const url = trpcUrl(config);
  const headers = buildBatchHeaders(config);
  return createTRPCClient<AppRouter>({
    links: [
      splitLink({
        condition: (op) => op.type === 'subscription',
        true: config
          ? httpSubscriptionLink({
              url,
              // eventsource v3 is fetch-based and accepts a custom `fetch` in its init dict,
              // which is how we inject x-cortex-token on the SSE connection cross-origin.
              // The `as any` cast avoids a structural mismatch between the eventsource v3
              // class's EventTarget-based addEventListener signature and tRPC's internal
              // EventSourceLike.Instance type — the runtime behaviour is correct.
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              EventSource: ExtEventSource as any,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              eventSourceOptions: (() => ({ fetch: buildSseFetch(config.token) })) as any,
            })
          : httpSubscriptionLink({ url }),
        false: httpBatchLink({
          url,
          headers: () => headers,
          fetch: credentialSafeFetch(config?.serverUrl),
        }),
      }),
    ],
  });
}
