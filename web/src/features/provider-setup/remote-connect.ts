import type { Vocab } from '@/i18n';

export type ProbeOutcome = 'ok' | 'rejected' | 'unreachable';

export function normalizeServerUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

/** Reach the server's tRPC endpoint with the token; only a 401 says the token is wrong. */
export async function probeServer(serverUrl: string, token: string, fetchImpl: typeof fetch = fetch): Promise<ProbeOutcome> {
  try {
    const response = await fetchImpl(`${serverUrl}/trpc/`, {
      headers: { 'x-cortex-token': token }, signal: AbortSignal.timeout(8000),
    });
    return response.status === 401 ? 'rejected' : 'ok';
  } catch {
    return 'unreachable';
  }
}

export function probeFailureText(outcome: Exclude<ProbeOutcome, 'ok'>, L: Vocab): string {
  return outcome === 'rejected' ? L.onbTokenRejected : L.onbUnreachable;
}
