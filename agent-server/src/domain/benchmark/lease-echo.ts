// input:  the frozen phase-B policy and the container's monotonic clock
// output: the lease-echo document and its delivery to the per-trial proxy's control route
// pos:    Container-side credential-lease echo writer
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { remainingDeadlineMs, type ResolvedTrialPolicy } from './resolved-policy.js';

export const LEASE_ECHO_SCHEMA_VERSION = 'cortex-bench-lease-echo/1';
export const LEASE_ECHO_PATH = '/_cortex/lease-echo';

/**
 * Everything here is read on a container clock: the two instants come from the frozen policy's own
 * compile-time wall-clock reads, and the remaining budget from the monotonic clock. No host instant
 * is read, and none is sent — only durations may cross to the host, because a duration is a
 * difference of two readings of one clock and so survives any offset between the two clocks.
 */
export interface LeaseEchoDocument {
  schema_version: typeof LEASE_ECHO_SCHEMA_VERSION;
  trial_id: string;
  compiled_at_epoch_ms: number;
  absolute_epoch_ms: number;
  remaining_ms: number;
}

export interface LeaseEchoResult {
  ok: boolean;
  lease_state: 'reconciled' | 'clamped';
  armed_remaining_ms: number;
}

export interface LeaseEchoTransportResponse {
  status: number;
  body: string;
}

export interface LeaseEchoDependencies {
  monotonic_ns(): bigint;
  post?(
    url: string, headers: Record<string, string>, body: string,
  ): Promise<LeaseEchoTransportResponse>;
}

export class LeaseEchoRefused extends Error {
  constructor(readonly status: number, readonly reason: string) {
    super(`lease echo refused: ${status} ${reason}`);
    this.name = 'LeaseEchoRefused';
  }
}

export function composeLeaseEcho(
  policy: ResolvedTrialPolicy,
  monotonicNowNs: bigint,
): LeaseEchoDocument {
  return {
    schema_version: LEASE_ECHO_SCHEMA_VERSION,
    trial_id: policy.trial_id,
    compiled_at_epoch_ms: policy.deadline.compiled_at_epoch_ms,
    absolute_epoch_ms: policy.deadline.absolute_epoch_ms,
    remaining_ms: remainingDeadlineMs(policy, monotonicNowNs),
  };
}

export function leaseEchoUrl(proxyBaseUrl: string): string {
  return `${proxyBaseUrl.replace(/\/+$/, '')}${LEASE_ECHO_PATH}`;
}

/** The echo runs before the model process is admitted, so it may not stall the trial's startup. */
export const LEASE_ECHO_TIMEOUT_MS = 10_000;

async function fetchTransport(
  url: string, headers: Record<string, string>, body: string,
): Promise<LeaseEchoTransportResponse> {
  const response = await fetch(url, {
    method: 'POST', headers, body, signal: AbortSignal.timeout(LEASE_ECHO_TIMEOUT_MS),
  });
  return { status: response.status, body: await response.text() };
}

function parseResult(response: LeaseEchoTransportResponse): LeaseEchoResult {
  const document = JSON.parse(response.body) as Partial<LeaseEchoResult & { error: string }>;
  if (response.status !== 200) {
    throw new LeaseEchoRefused(response.status, document.error ?? 'lease_echo_refused');
  }
  return document as LeaseEchoResult;
}

/**
 * Publish the echo to the trial's own proxy. The route authenticates it exactly as it authenticates
 * a model call, so the container presents the same dummy bearer it presents there.
 */
export async function publishLeaseEcho(
  policy: ResolvedTrialPolicy,
  deps: LeaseEchoDependencies,
): Promise<LeaseEchoResult> {
  const document = composeLeaseEcho(policy, deps.monotonic_ns());
  const response = await (deps.post ?? fetchTransport)(
    leaseEchoUrl(policy.credential.proxy_base_url),
    {
      'content-type': 'application/json',
      authorization: `Bearer ${policy.credential.dummy_token_ref}`,
    },
    JSON.stringify(document),
  );
  return parseResult(response);
}
