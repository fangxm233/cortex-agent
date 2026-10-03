import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { DATA_DIR, PROMPTS_DIR } from '@core/paths.js';
import { createLogger } from '@core/log.js';
import { resolveTemplate } from './prompt-includes.js';

const log = createLogger('environments');

/** Prompt fields accept `file:<name>` to read the text from `prompts/<subdir>/<name>`. */
export const FILE_REF_PREFIX = 'file:';
export const PROMPT_FIELD_DIRS: Record<string, string> = {
  directive: 'directives',
  promptTemplate: 'promptTemplates',
  systemPrompt: 'systemPrompts',
};

/** Resolve a `file:<name>` reference for a given field. Returns the value unchanged when it is not
 *  a file ref, names a field without a prompt directory, or cannot be read (logged). */
export function resolveFileRef(field: string, value: string | undefined): string | undefined {
  if (!value || !value.startsWith(FILE_REF_PREFIX)) return value;
  const filename = value.slice(FILE_REF_PREFIX.length);
  const subdir = PROMPT_FIELD_DIRS[field];
  if (!subdir) return value;
  const filePath = path.join(PROMPTS_DIR, subdir, filename);
  try {
    const raw = readFileSync(filePath, 'utf8');
    return resolveTemplate(raw, path.join(PROMPTS_DIR, subdir, 'templates'));
  } catch (e: any) {
    log.error(`Failed to read ${field} file ref "${value}": ${e.message}`);
    return value;
  }
}

/** Absolute paths are returned as-is; relative ones resolve against DATA_DIR (plugins live under
 *  DATA_DIR/plugins/). */
export function resolvePluginDir(dir: string): string {
  if (path.isAbsolute(dir)) return dir;
  return path.join(DATA_DIR, dir);
}

/** Filesystem probes for the validators' `file:` ref and pluginDirs existence checks. Omitted in
 *  unit tests, injected by the loaders and the API handlers. */
export interface RefResolver {
  promptsDir: string;
  pluginBaseDir: string;
  join: (...parts: string[]) => string;
  exists: (absPath: string) => boolean;
  isAbsolute: (p: string) => boolean;
}

export function fsRefResolver(): RefResolver {
  return {
    promptsDir: PROMPTS_DIR,
    pluginBaseDir: DATA_DIR,
    join: path.join,
    exists: existsSync,
    isAbsolute: path.isAbsolute,
  };
}
