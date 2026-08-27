// input:  mobile route tree and shared shell-router factory
// output: concrete mobile data router with shell-appropriate history
// pos:    Mobile-only router instance; desktop tree remains separate
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { createShellRouter } from '@/router-factory';
import { mobileRoutes } from './mobile-routes';

export const mobileRouter = createShellRouter(mobileRoutes);
