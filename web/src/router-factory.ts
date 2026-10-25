import { createElement } from 'react';
import { createBrowserRouter, createHashRouter, type RouteObject } from 'react-router-dom';
import { isNativeShell } from '@/lib/desktop-config';
import { registerRouteTemplates } from '@/features/telemetry/route-template';
import { RouteErrorFallback } from '@/features/telemetry/RouteErrorFallback';

/** Every top-level route reports its render errors and shows the crash fallback. */
function withErrorElement(route: RouteObject): RouteObject {
  return { errorElement: createElement(RouteErrorFallback), ...route } as RouteObject;
}

export function createShellRouter(
  routes: RouteObject[],
  nativeShell = isNativeShell(),
): ReturnType<typeof createBrowserRouter> {
  const createRouter = nativeShell ? createHashRouter : createBrowserRouter;
  // Crash reports name the route pattern, matched against this tree.
  registerRouteTemplates(routes);
  return createRouter(routes.map(withErrorElement));
}
