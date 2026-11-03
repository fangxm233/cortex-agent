// A throttle entry is filed under its provider and the route (connection) its traffic ran on, so
// one account's limit never holds another account's work. An entry without a route — an outage —
// covers every route of its provider.

const SEPARATOR = '::';

export function throttleKey(provider: string, route?: string | null): string {
  return route ? `${provider}${SEPARATOR}${route}` : provider;
}

export function parseThrottleKey(key: string): { provider: string; route: string | null } {
  const at = key.indexOf(SEPARATOR);
  if (at < 0) return { provider: key, route: null };
  return { provider: key.slice(0, at), route: key.slice(at + SEPARATOR.length) };
}

/** Whether work filed under `key` waits on an active entry: its own, or its provider's route-less
 *  one. A bare provider key (written before routes) waits on every route of that provider. */
export function throttleKeyBlocked(key: string, active: ReadonlySet<string>): boolean {
  if (active.has(key)) return true;
  const { provider, route } = parseThrottleKey(key);
  if (route) return active.has(provider);
  return [...active].some((candidate) => parseThrottleKey(candidate).provider === provider);
}
