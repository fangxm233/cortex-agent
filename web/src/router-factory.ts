// input:  route objects and canonical native-shell detection
// output: data router using hash history for native shells or browser history otherwise
// pos:    Shared thin router factory; desktop and mobile route trees remain separate
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { createBrowserRouter, createHashRouter, type RouteObject } from 'react-router-dom';
import { isNativeShell } from '@/lib/desktop-config';

export function createShellRouter(
  routes: RouteObject[],
  nativeShell = isNativeShell(),
): ReturnType<typeof createBrowserRouter> {
  const createRouter = nativeShell ? createHashRouter : createBrowserRouter;
  return createRouter(routes);
}
