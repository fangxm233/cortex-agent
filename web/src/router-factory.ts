import { createBrowserRouter, createHashRouter, type RouteObject } from 'react-router-dom';
import { isNativeShell } from '@/lib/desktop-config';

export function createShellRouter(
  routes: RouteObject[],
  nativeShell = isNativeShell(),
): ReturnType<typeof createBrowserRouter> {
  const createRouter = nativeShell ? createHashRouter : createBrowserRouter;
  return createRouter(routes);
}
