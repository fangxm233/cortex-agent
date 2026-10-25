import type { Vocab } from '@/i18n';
import { looksLikePairingCode, redeemPairingCode } from '@/lib/pairing';

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

/** `token` is what the app stores; empty after a test of a pairing code, which is not spent. */
export type ConnectionCheck = { ok: true; token: string; text: string } | { ok: false; text: string };

interface CheckOptions {
  deviceName: string;
  fetchImpl?: typeof fetch;
}

async function checkToken(serverUrl: string, token: string, L: Vocab, fetchImpl?: typeof fetch): Promise<ConnectionCheck> {
  const outcome = await probeServer(serverUrl, token, fetchImpl);
  return outcome === 'ok' ? { ok: true, token, text: L.onbVerified } : { ok: false, text: probeFailureText(outcome, L) };
}

async function checkCode(serverUrl: string, code: string, save: boolean, L: Vocab, opts: CheckOptions): Promise<ConnectionCheck> {
  if (!save) {
    const outcome = await probeServer(serverUrl, '', opts.fetchImpl);
    return outcome === 'unreachable' ? { ok: false, text: L.onbUnreachable } : { ok: true, token: '', text: L.onbReachable };
  }
  const redeemed = await redeemPairingCode(serverUrl, code, opts.deviceName, opts.fetchImpl);
  if (redeemed.ok) return { ok: true, token: redeemed.token, text: L.onbVerified };
  return { ok: false, text: redeemed.reason === 'rejected' ? L.onbCodeRejected : L.onbUnreachable };
}

/** Test (`save` false) or prepare (`save` true) a connection from a client token or a pairing code. */
export function checkConnection(
  serverUrl: string, secret: string, save: boolean, L: Vocab, opts: CheckOptions,
): Promise<ConnectionCheck> {
  return looksLikePairingCode(secret)
    ? checkCode(serverUrl, secret, save, L, opts)
    : checkToken(serverUrl, secret, L, opts.fetchImpl);
}
