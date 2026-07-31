// input:  context path, filesystem, runtime settings
// output: loadUserContext
// pos:    Loads the user profile for direct conversation turns
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { readFileSync, statSync } from 'fs';
import * as path from 'path';
import { getSettings } from '@core/settings.js';
import { CONTEXT_DIR } from '@core/utils.js';

const USER_MD_PATH = path.join(CONTEXT_DIR, 'user', 'USER.md');

let cachedContent: string | null = null;
let cachedMtimeMs = 0;

function readUserMd(): string | null {
  try {
    const stat = statSync(USER_MD_PATH);
    if (stat.mtimeMs === cachedMtimeMs && cachedContent !== null) return cachedContent;
    cachedContent = readFileSync(USER_MD_PATH, 'utf8');
    cachedMtimeMs = stat.mtimeMs;
    return cachedContent;
  } catch {
    return null;
  }
}

/**
 * The user profile for plain, thread-free conversation turns. Injected by default;
 * set CORTEX_DISABLE_USER_CONTEXT=1 to opt out. Multi-agent thread steps deliberately
 * do NOT inject this — only the direct conversation path calls it.
 */
export function loadUserContext(): string | null {
  if (getSettings().disableUserContext) return null;

  const content = readUserMd();
  if (!content) return null;

  return `[User Context]\n${content}\n[/User Context]`;
}
