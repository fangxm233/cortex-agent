// input:  UiServiceDeps + ThreadTemplateDetailParams { kind, name }
// output: threadTemplates.detail handler → ThreadTemplateDetail
// pos:    The drill-in the templates panel never had. Beyond the raw body it answers the three
//         questions the editor needs before it lets anyone type: is this entity currently valid,
//         what else depends on it, and is anything running on it right now — because transitions
//         are re-read on every step, so a save can reroute or stall a live thread.
//         For a shell-binding template it also returns the expanded graph, which is otherwise
//         impossible to see: `execute-review.json` is four lines that bind a shell.
// >>> If I am updated, update CORTEX.md <<<

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { DEFAULTS_DIR } from '@core/paths.js';
import {
  validateEntity,
  rawRegistryFromDir,
  dependentTemplates,
  type RawRegistry,
} from '@domain/threads/template-validate.js';
import { readEntity, entityPath } from '@domain/threads/template-writer.js';
import { loaderRefResolver, CONFIG_TEMPLATES_DIR } from '@domain/threads/template-loader.js';
import { isShellBinding, expandShell } from '@domain/threads/shell-templates.js';
import type { AgentDefinition, ShellDefinition, ShellTemplateBinding } from '@core/types/thread-types.js';
import type {
  UiServiceDeps,
  ThreadTemplateDetailParams,
  ThreadTemplateDetail,
  ThreadTemplateOrigin,
} from '../types.js';

const IO = {
  readdirSync: (p: string) => readdirSync(p),
  readFileSync: (p: string, enc: 'utf8') => readFileSync(p, enc),
  existsSync,
  join: path.join,
};

const SUBDIR: Record<ThreadTemplateDetailParams['kind'], string> = {
  template: 'templates',
  agent: 'agents',
  shell: 'shells',
};

const TERMINAL_THREAD_STATUSES = new Set(['completed', 'failed', 'cancelled', 'aborted']);

/**
 * Compare against the shipped defaults. `mergeThreadTemplates` is copy-if-missing and never
 * overwrites, so a user file that differs from its default has forked permanently — it will not
 * receive upstream changes. Worth knowing before editing.
 */
export function classifyOrigin(
  defaultsRoot: string,
  kind: ThreadTemplateDetailParams['kind'],
  name: string,
  userContent: string | null,
): ThreadTemplateOrigin {
  const shipped = path.join(defaultsRoot, 'config', 'thread-templates', SUBDIR[kind], `${name}.json`);
  if (!existsSync(shipped)) return 'custom';
  try {
    return readFileSync(shipped, 'utf8') === userContent ? 'stock' : 'modified';
  } catch {
    return 'custom';
  }
}

/** Expand a shell-binding template so the editor can show the graph it actually runs. */
function expandBinding(name: string, body: unknown, registry: RawRegistry): Record<string, unknown> | null {
  if (!isShellBinding(body)) return null;
  const shell = registry.shells[body.shell];
  if (!shell || typeof shell !== 'object') return null;
  const agents: Record<string, AgentDefinition> = {};
  for (const [agentName, agentBody] of Object.entries(registry.agents)) {
    if (agentBody && typeof agentBody === 'object') agents[agentName] = agentBody as AgentDefinition;
  }
  try {
    return expandShell(name, body as ShellTemplateBinding, shell as ShellDefinition, agents) as unknown as Record<string, unknown>;
  } catch {
    return null; // the validator already reports why
  }
}

export async function handleThreadTemplatesDetail(
  deps: UiServiceDeps,
  params: ThreadTemplateDetailParams,
): Promise<ThreadTemplateDetail> {
  const { kind, name } = params;
  const entity = readEntity(CONFIG_TEMPLATES_DIR, kind, name);
  const registry = rawRegistryFromDir(CONFIG_TEMPLATES_DIR, IO);
  const { errors, warnings } = validateEntity(kind, name, entity.body, registry, loaderRefResolver());

  const rawContent = existsSync(entity.filePath) ? readFileSync(entity.filePath, 'utf8') : null;

  // Transitions are re-read every step, so a live thread on this template is the thing a user most
  // needs to know about before saving.
  const runningThreads =
    kind === 'template'
      ? deps.threadStore.getAll().filter(
          (thread: { templateName?: string | null; status?: string }) =>
            thread.templateName === name && !TERMINAL_THREAD_STATUSES.has(String(thread.status)),
        ).length
      : 0;

  const referencingTasks =
    kind === 'template'
      ? deps.taskStore.getAll().filter(
          (task: { template?: string | null; status?: string }) =>
            task.template === name && task.status !== 'done',
        ).length
      : 0;

  const description =
    entity.body && typeof entity.body.description === 'string' ? entity.body.description : null;

  return {
    kind,
    name,
    description,
    body: entity.body,
    filePath: entity.filePath,
    origin: classifyOrigin(DEFAULTS_DIR, kind, name, rawContent),
    sha256: entity.sha256,
    errors,
    warnings,
    usedByTemplates: dependentTemplates(kind, name, registry),
    runningThreads,
    referencingTasks,
    expanded: kind === 'template' ? expandBinding(name, entity.body, registry) : null,
  };
}
