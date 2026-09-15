// input:  a token typed by the user, and the server's /api/ui/session probe
// output: probeUiSession() / uiLogin() / uiLogout()
// pos:    Browser-mode authentication seam. The token is posted ONCE and exchanged for an HttpOnly
//         cookie the page can never read; every later tRPC/SSE/file request rides that cookie
//         automatically, which is why nothing else in the SPA needs to know about it.
// >>> Once updated, update this header and parent CORTEX.md <<<

export const UI_SESSION_PATH = '/api/ui/session';
export const UI_LOGIN_PATH = '/api/ui/login';
export const UI_LOGOUT_PATH = '/api/ui/logout';

export interface UiSessionState {
  /** This browser already passes the server's auth gate (cookie, or Cloudflare Access at the edge). */
  authenticated: boolean;
  /** The server offers token login, so showing a token form here can actually work. */
  tokenLogin: boolean;
}

/**
 * Ask the server where we stand. Throws on a network/protocol failure so the caller can show
 * "cannot reach the server" instead of a login form that would not help.
 */
export async function probeUiSession(): Promise<UiSessionState> {
  const res = await fetch(UI_SESSION_PATH, { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw new Error(`session probe failed (${res.status})`);
  const body = (await res.json()) as { data?: Partial<UiSessionState> };
  return {
    authenticated: body.data?.authenticated === true,
    tokenLogin: body.data?.tokenLogin === true,
  };
}

/**
 * Exchange the token for a session cookie. Resolves with an error string rather than throwing for
 * the expected failure (a wrong token) — that is a normal outcome of a form, not an exception.
 */
export async function uiLogin(token: string): Promise<{ ok: true } | { ok: false; status: number }> {
  const res = await fetch(UI_LOGIN_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  return res.ok ? { ok: true } : { ok: false, status: res.status };
}

/** Revoke this browser's session server-side and drop the cookie. */
export async function uiLogout(): Promise<void> {
  await fetch(UI_LOGOUT_PATH, { method: 'POST', credentials: 'same-origin' });
}
