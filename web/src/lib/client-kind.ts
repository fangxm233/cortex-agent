export type ClientKind = 'desktop' | 'android' | 'browser';

/** Request header that tells the server which client a call came from (usage split by entry). */
export const CLIENT_KIND_HEADER = 'x-cortex-client';

// The same shell flags `desktop-config` reads; read directly so that module can import this one.
export function clientKind(): ClientKind {
  const flags = globalThis as { __CORTEX_DESKTOP__?: boolean; __CORTEX_MOBILE__?: boolean };
  if (flags.__CORTEX_MOBILE__ === true) return 'android';
  return flags.__CORTEX_DESKTOP__ === true ? 'desktop' : 'browser';
}

// Native shells call the server cross-origin, so a header the server does not allow-list fails
// the CORS preflight of every request. They start sending it only once the server has answered a
// call that only servers allowing it know (`allowClientKindHeader`). The browser is same-origin.
let nativeHeaderAllowed = false;

export function allowClientKindHeader(): void {
  nativeHeaderAllowed = true;
}

export function clientKindHeaders(): Record<string, string> {
  const kind = clientKind();
  if (kind !== 'browser' && !nativeHeaderAllowed) return {};
  return { [CLIENT_KIND_HEADER]: kind };
}

/** Test seam: forget that the server accepts the header. */
export function resetClientKindHeaderForTest(): void {
  nativeHeaderAllowed = false;
}
