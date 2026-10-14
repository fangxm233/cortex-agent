import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { DATA_DIR, DEFAULTS_DIR, PROMPTS_DIR } from '@core/paths.js';
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

/** The shipped prompt files, read in place. A user file of the same name under PROMPTS_DIR wins. */
export const DEFAULT_PROMPTS_DIR = path.join(DEFAULTS_DIR, 'prompts');

/** The prompts root a `<subdir>/<filename>` ref reads from: the user's when it has the file, else
 *  the shipped one when that does. */
function promptRoot(subdir: string, filename: string): string {
  if (existsSync(path.join(PROMPTS_DIR, subdir, filename))) return PROMPTS_DIR;
  return existsSync(path.join(DEFAULT_PROMPTS_DIR, subdir, filename)) ? DEFAULT_PROMPTS_DIR : PROMPTS_DIR;
}

/** Resolve a `file:<name>` reference for a given field. Returns the value unchanged when it is not
 *  a file ref, names a field without a prompt directory, or cannot be read (logged). */
export function resolveFileRef(field: string, value: string | undefined): string | undefined {
  if (!value || !value.startsWith(FILE_REF_PREFIX)) return value;
  const filename = value.slice(FILE_REF_PREFIX.length);
  const subdir = PROMPT_FIELD_DIRS[field];
  if (!subdir) return value;
  const root = promptRoot(subdir, filename);
  try {
    const raw = readFileSync(path.join(root, subdir, filename), 'utf8');
    return resolveTemplate(raw, path.join(root, subdir, 'templates'));
  } catch (e: any) {
    log.error(`Failed to read ${field} file ref "${value}": ${e.message}`);
    return value;
  }
}

/** Filesystem probes for the validators' `file:` ref and pluginDirs existence checks. Omitted in
 *  unit tests, injected by the loaders and the API handlers. */
export interface RefResolver {
  promptsDir: string;
  pluginBaseDir: string;
  /** The install's defaults/: a prompt file or `plugins/<id>` found there exists as a built-in. */
  builtinDir: string;
  join: (...parts: string[]) => string;
  exists: (absPath: string) => boolean;
  isAbsolute: (p: string) => boolean;
}

export function fsRefResolver(): RefResolver {
  return {
    promptsDir: PROMPTS_DIR,
    pluginBaseDir: DATA_DIR,
    builtinDir: DEFAULTS_DIR,
    join: path.join,
    exists: existsSync,
    isAbsolute: path.isAbsolute,
  };
}
