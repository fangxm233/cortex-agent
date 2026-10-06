import { z } from 'zod';
import { t } from '@core/i18n.js';
import { FILE_REF_PREFIX, PROMPT_FIELD_DIRS, type RefResolver } from './file-refs.js';

/** `path` anchors the issue at a field (`pluginDirs[2]`) so the editor can point at it. */
export interface Issue {
  path: string;
  message: string;
}

export interface ValidationResult {
  errors: Issue[];
  warnings: Issue[];
}

/** The execution-environment fields, spelled once: an environment declares them, and a per-use
 *  override may replace them. */
export const environmentFieldsShape = {
  loadRules: z.boolean().optional(),
  disableHooks: z.boolean().optional(),
  skills: z.boolean().optional(),
  settingSources: z.array(z.enum(['user', 'project', 'local'])).optional(),
  projectContext: z.boolean().optional(),
};

/** One `config/environments/<name>.json`. Exported for the compile-time parity guard in
 *  schema.parity.ts, which pins it against `AgentDefinition`. */
export const environmentSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  profile: z.string().min(1),
  persistSession: z.boolean().optional(),
  directive: z.string().optional(),
  systemPrompt: z.string().optional(),
  promptTemplate: z.string().optional(),
  claudeAgent: z.string().optional(),
  outputStyle: z.string().optional(),
  tools: z.string().optional(),
  pluginDirs: z.array(z.string()).optional(),
  mcpComposition: z.enum(['direct', 'none']).optional(),
  mcpToolAllowlist: z.array(z.string()).optional(),
  delegable: z.boolean().optional(),
  ...environmentFieldsShape,
});

// Keys the schema knows about. Anything else is a warning, never an error.
const ENVIRONMENT_KEYS = new Set(Object.keys(environmentSchema.shape));

function formatPath(segments: ReadonlyArray<PropertyKey>): string {
  let out = '';
  for (const seg of segments) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out === '' ? String(seg) : `.${String(seg)}`;
  }
  return out;
}

/** Zod issues as anchored validation issues. */
export function zodIssues(result: z.ZodSafeParseResult<unknown>): Issue[] {
  if (result.success) return [];
  return result.error.issues.map((issue) => ({
    path: formatPath(issue.path) || '(root)',
    message: issue.message,
  }));
}

export function unknownKeyWarnings(body: Record<string, unknown>, known: ReadonlySet<string>): Issue[] {
  return Object.keys(body)
    .filter((key) => !known.has(key))
    .map((key) => ({ path: key, message: t('ux.tpl.unknownField', { key }) }));
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Warn when a `file:` prompt reference names a file that does not exist. */
export function checkPromptFileRef(
  field: string,
  value: unknown,
  path: string,
  refs: RefResolver | undefined,
  warnings: Issue[],
): void {
  if (!refs || typeof value !== 'string' || !value.startsWith(FILE_REF_PREFIX)) return;
  const subdir = PROMPT_FIELD_DIRS[field];
  if (!subdir) return;
  const filename = value.slice(FILE_REF_PREFIX.length);
  if (!refs.exists(refs.join(refs.promptsDir, subdir, filename))) {
    warnings.push({
      path,
      message: t('ux.tpl.promptFileMissing', { subdir, filename, value }),
    });
  }
}

/** Warn about every plugin directory that does not exist. */
export function checkPluginDirs(pluginDirs: unknown, refs: RefResolver | undefined, warnings: Issue[]): void {
  if (!refs || !Array.isArray(pluginDirs)) return;
  pluginDirs.forEach((dir, i) => {
    if (typeof dir !== 'string') return;
    const abs = refs.isAbsolute(dir) ? dir : refs.join(refs.pluginBaseDir, dir);
    if (!refs.exists(abs)) {
      warnings.push({ path: `pluginDirs[${i}]`, message: t('ux.tpl.pluginDirMissing', { dir }) });
    }
  });
}

/**
 * Validate one environment body against the file name it lives under. Shape errors and a name that
 * does not match the file block a save; unknown keys and missing prompt files or plugin directories
 * are warnings — the loader still runs with them.
 */
export function validateEnvironment(name: string, body: unknown, refs?: RefResolver): ValidationResult {
  if (!isPlainObject(body)) {
    return { errors: [{ path: '(root)', message: t('ux.tpl.bodyNotObject') }], warnings: [] };
  }
  const result: ValidationResult = {
    errors: zodIssues(environmentSchema.safeParse(body)),
    warnings: unknownKeyWarnings(body, ENVIRONMENT_KEYS),
  };
  // The file name is the identity, and the loader skips a file whose `name` disagrees with it.
  if (typeof body.name === 'string' && body.name !== name) {
    result.errors.push({ path: 'name', message: t('ux.tpl.nameMismatch', { name: body.name, file: name }) });
  }
  for (const field of ['directive', 'systemPrompt', 'promptTemplate']) {
    checkPromptFileRef(field, body[field], field, refs, result.warnings);
  }
  checkPluginDirs(body.pluginDirs, refs, result.warnings);
  return result;
}
