import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { atomicWriteSync } from '@core/atomic-write.js';
import { DEFAULTS_DIR, PROMPTS_DIR } from '@core/paths.js';
import { t } from '@core/i18n.js';
import { FILE_REF_PREFIX, PROMPT_FIELD_DIRS, type RefResolver } from './file-refs.js';
import { ENVIRONMENTS_DIR } from './paths.js';
import { listEnvironmentNames, readEnvironment, saveEnvironment, writeError } from './entities.js';

/** Where an environment's `systemPrompt` comes from: a `file:` ref, literal text, or nothing (the
 *  backend's own default). */
export type SystemPromptKind = 'file' | 'inline' | 'none';

export interface EnvironmentSystemPrompt {
  kind: SystemPromptKind;
  /** The `file:` ref target under `prompts/systemPrompts/`; null unless `kind` is `file`. */
  file: string | null;
  /** The text the field resolves to, unrendered: the file's raw bytes or the literal. */
  text: string;
  /** Other environments whose `systemPrompt` names the same file. */
  sharedWith: string[];
  /** The shipped copy of the same file, when there is one. */
  defaultText: string | null;
}

export interface SystemPromptDirs {
  envDir: string;
  promptDir: string;
  defaultPromptDir: string;
}

const SUBDIR = PROMPT_FIELD_DIRS.systemPrompt;

export function systemPromptDirs(envDir: string = ENVIRONMENTS_DIR): SystemPromptDirs {
  return {
    envDir,
    promptDir: path.join(PROMPTS_DIR, SUBDIR),
    defaultPromptDir: path.join(DEFAULTS_DIR, 'prompts', SUBDIR),
  };
}

function fileRefName(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith(FILE_REF_PREFIX)) return null;
  return value.slice(FILE_REF_PREFIX.length) || null;
}

function readText(filePath: string): string | null {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
}

/** The ref resolved inside `dir`; null when it would land outside it. */
function containedPath(dir: string, file: string): string | null {
  const target = path.resolve(dir, file);
  const rel = path.relative(dir, target);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? target : null;
}

/** Environments other than `except` whose `systemPrompt` is `file:<file>`. */
export function promptFileUsers(envDir: string, file: string, except: string): string[] {
  const ref = `${FILE_REF_PREFIX}${file}`;
  return listEnvironmentNames(envDir).filter((name) => {
    if (name === except) return false;
    try {
      return readEnvironment(envDir, name).body?.systemPrompt === ref;
    } catch {
      return false;
    }
  });
}

/** What the editor shows for one environment's `systemPrompt`, from its raw body. */
export function readEnvironmentSystemPrompt(
  name: string,
  body: Record<string, unknown> | null,
  dirs: SystemPromptDirs = systemPromptDirs(),
): EnvironmentSystemPrompt {
  const value = body?.systemPrompt;
  const file = fileRefName(value);
  if (file) {
    const own = containedPath(dirs.promptDir, file);
    const shipped = containedPath(dirs.defaultPromptDir, file);
    return {
      kind: 'file',
      file,
      text: (own && readText(own)) ?? '',
      sharedWith: promptFileUsers(dirs.envDir, file, name),
      defaultText: shipped ? readText(shipped) : null,
    };
  }
  const inline = typeof value === 'string' && value.length > 0;
  return { kind: inline ? 'inline' : 'none', file: null, text: inline ? value : '', sharedWith: [], defaultText: null };
}

export interface SaveSystemPromptResult {
  changed: boolean;
  /** The prompt file now backing the environment; null when it uses the backend default. */
  file: string | null;
}

function writePromptFile(dirs: SystemPromptDirs, file: string, text: string): boolean {
  const target = containedPath(dirs.promptDir, file);
  if (!target) throw writeError('invalid-args', t('ux.env.promptFileOutside', { file }));
  if (readText(target) === text) return false;
  atomicWriteSync(target, text);
  return true;
}

/**
 * Replace one environment's system prompt with `text`. A `file:` ref is edited in place (every
 * environment naming that file sees the change). Literal text or no prompt moves to a new
 * `<name>.md` the environment then refs; empty text there drops the field, i.e. the backend default.
 */
export function saveEnvironmentSystemPrompt(
  name: string,
  text: string,
  dirs: SystemPromptDirs = systemPromptDirs(),
  refs?: RefResolver,
): SaveSystemPromptResult {
  const env = readEnvironment(dirs.envDir, name);
  if (!env.body) throw writeError('invalid-args', t('ux.tpl.bodyNotObject'));
  const file = fileRefName(env.body.systemPrompt);
  if (file) return { changed: writePromptFile(dirs, file, text), file };

  if (text.trim() === '') {
    const body = { ...env.body };
    delete body.systemPrompt;
    const saved = saveEnvironment(dirs.envDir, { name, body, baseHash: env.sha256 }, refs);
    return { changed: saved.changed, file: null };
  }
  const target = `${name}.md`;
  const users = promptFileUsers(dirs.envDir, target, name);
  if (users.length > 0) {
    throw writeError('conflict', t('ux.env.promptFileInUse', { file: target, envs: users.join(', ') }));
  }
  writePromptFile(dirs, target, text);
  // Spreading keeps an inline field at its position; an absent one is appended.
  const body = { ...env.body, systemPrompt: `${FILE_REF_PREFIX}${target}` };
  saveEnvironment(dirs.envDir, { name, body, baseHash: env.sha256 }, refs);
  return { changed: true, file: target };
}
