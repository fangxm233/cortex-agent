import { matchRoutes, type RouteObject } from 'react-router-dom';

// Crash reports carry the route pattern the page was on (`/m/session/:sessionId`), never the
// concrete path: ids, project names and file paths stay on the device.

let routes: RouteObject[] = [];

/** The app router registers its route tree once it is built. */
export function registerRouteTemplates(next: RouteObject[]): void {
  routes = next;
}

/** The router path of a location: the hash path under the native shells' hash router. */
export function routerPath(loc: Pick<Location, 'pathname' | 'hash'>): string {
  if (loc.hash.startsWith('#/')) return loc.hash.slice(1).split(/[?#]/)[0]!;
  return loc.pathname;
}

function joinPatterns(paths: string[]): string {
  const joined = paths.join('/').replace(/\/{2,}/g, '/');
  return joined.startsWith('/') ? joined : `/${joined}`;
}

/** The matched route pattern, or null when nothing matches (or no router is registered). */
export function routeTemplate(path: string, tree: RouteObject[] = routes): string | null {
  const matches = matchRoutes(tree, path);
  if (!matches) return null;
  const patterns = matches.map((match) => match.route.path).filter((p): p is string => !!p);
  return joinPatterns(patterns).slice(0, 80);
}

export function currentRouteTemplate(): string | null {
  if (typeof window === 'undefined') return null;
  return routeTemplate(routerPath(window.location));
}
