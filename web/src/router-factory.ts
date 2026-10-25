import { createBrowserRouter, createHashRouter, type RouteObject } from 'react-router-dom';
import { isNativeShell } from '@/lib/desktop-config';
import { registerRouteTemplates } from '@/features/telemetry/route-template';

export function createShellRouter(
  routes: RouteObject[],
  nativeShell = isNativeShell(),
): ReturnType<typeof createBrowserRouter> {
  const createRouter = nativeShell ? createHashRouter : createBrowserRouter;
  // Crash reports name the route pattern, matched against this tree.
  registerRouteTemplates(routes);
  return createRouter(routes);
}
