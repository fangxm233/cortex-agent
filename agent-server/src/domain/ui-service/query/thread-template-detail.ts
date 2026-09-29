import { existsSync, readFileSync } from 'node:fs';
import {
  validateEntity,
  dependentTemplates,
  type RawRegistry,
} from '@domain/threads/template-validate.js';
import { readEntity, readRawRegistry } from '@domain/threads/template-writer.js';
import { loaderRefResolver, CONFIG_TEMPLATES_DIR } from '@domain/threads/template-loader.js';
import { isShellBinding, expandShell } from '@domain/threads/shell-templates.js';
import { classifyOrigin } from './thread-templates.js';
import type { AgentDefinition, ShellDefinition, ShellTemplateBinding } from '@core/types/thread-types.js';
import type {
  UiServiceDeps,
  ThreadTemplateDetailParams,
  ThreadTemplateDetail,
} from '../types.js';

const TERMINAL_THREAD_STATUSES = new Set(['completed', 'failed', 'cancelled', 'aborted']);

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
  const registry = readRawRegistry(CONFIG_TEMPLATES_DIR);
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
    origin: await classifyOrigin(kind, name, rawContent),
    sha256: entity.sha256,
    errors,
    warnings,
    usedByTemplates: dependentTemplates(kind, name, registry),
    runningThreads,
    referencingTasks,
    expanded: kind === 'template' ? expandBinding(name, entity.body, registry) : null,
  };
}
