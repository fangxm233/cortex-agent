// One-time pairing codes (server: agent-server/src/platform/ui-http/ui-pairing.ts). A new app or
// browser types a short code minted on a signed-in device instead of the 64-char client token.

/** Crockford base32, as the server mints it; O, I and L are read as the digits they resemble. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const LOOKALIKES: Record<string, string> = { O: '0', I: '1', L: '1' };
const CODE_LENGTH = 8;
const HASH_KEY = 'pair';

export const UI_PAIR_PATH = '/api/ui/pair';

/** Whether typed input is a pairing code (as opposed to a client token). */
export function looksLikePairingCode(input: string): boolean {
  const raw = input.toUpperCase().replace(/[\s-]/g, '');
  return raw.length === CODE_LENGTH && [...raw].every((ch) => ALPHABET.includes(LOOKALIKES[ch] ?? ch));
}

/** A link that carries both the server address and the code: `https://host/#pair=ABCD-EFGH`. */
export function pairingLink(serverUrl: string, code: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/#${HASH_KEY}=${code}`;
}

/** The code in a `#pair=…` hash, or null. */
export function takePairingCodeFromHash(hash: string): string | null {
  const code = new URLSearchParams(hash.replace(/^#/, '')).get(HASH_KEY);
  return code && looksLikePairingCode(code) ? code : null;
}

/** Split a pasted pairing link into the server address and the code; null for anything else. */
export function splitPairingLink(input: string): { serverUrl: string; code: string } | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const code = takePairingCodeFromHash(url.hash);
  if (!code) return null;
  return { serverUrl: `${url.origin}${url.pathname}`.replace(/\/+$/, ''), code };
}

export type RedeemOutcome = { ok: true; token: string } | { ok: false; reason: 'rejected' | 'unreachable' };

/** Trade a code for this app's own token. */
export async function redeemPairingCode(
  serverUrl: string, code: string, name: string, fetchImpl: typeof fetch = fetch,
): Promise<RedeemOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(`${serverUrl}${UI_PAIR_PATH}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name }), signal: AbortSignal.timeout(8000),
    });
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  const body = (await response.json().catch(() => null)) as { data?: { token?: unknown } } | null;
  const token = body?.data?.token;
  return response.ok && typeof token === 'string' ? { ok: true, token } : { ok: false, reason: 'rejected' };
}

const OS_NAMES: Array<[RegExp, string]> = [
  [/Android/i, 'Android'],
  [/iPhone|iPad/i, 'iOS'],
  [/Windows/i, 'Windows'],
  [/Mac OS X|Macintosh/i, 'macOS'],
  [/Linux|X11/i, 'Linux'],
];

/** How this app appears in the server's paired-device list. */
export function pairingDeviceName(userAgent: string, mobileShell: boolean): string {
  if (mobileShell && /Android/i.test(userAgent)) return 'Android';
  return OS_NAMES.find(([pattern]) => pattern.test(userAgent))?.[1] ?? 'Cortex';
}
