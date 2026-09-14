import { createLogger } from '@core/log.js';
import { Icons } from '../../../core/icons.js';
import { t } from '../../../core/i18n.js';
import type { Destination, PlatformAdapter } from '@platform/index.js';
import { threadStore } from '@store/thread-repo.js';
import { listTemplates, listAgents } from '@domain/threads/index.js';
import { runRegistry } from '../../../core/run-registry.js';
import * as executionRegistry from '@domain/executions/registry.js';
import { conduitQueues } from '../../conduit-queue.js';

const log = createLogger('thread-handlers');

async function handleThreadStatus(channel: string, adapter: PlatformAdapter) {
  const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
  const active = threadStore.findActive(channel);
  if (!active) {
    await adapter.postMessage(dest, { text: t('cmd.thread.noActive') });
    return;
  }
  const agents = Object.keys(active.agents).join(', ');
  const modeLabel = active.templateName ? active.templateName : t('cmd.thread.adHoc');
  const lines = [
    t('cmd.thread.activeHeader', { id: active.id, mode: modeLabel }),
    t('cmd.thread.statusLine', { status: active.status, agent: active.activeAgent }),
    t('cmd.thread.stepsLine', { steps: active.steps.length, cost: active.totalCostUsd.toFixed(4) }),
    t('cmd.thread.agentsLine', { agents }),
  ];
  if (active.status === 'aborted' && active.abortReason) {
    lines.push(t('cmd.thread.abortLine', { reason: active.abortReason }));
  }
  await adapter.postMessage(dest, { text: lines.join('\n') });
}

async function handleThreadTemplates(channel: string, adapter: PlatformAdapter) {
  const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
  const templates = listTemplates();
  if (templates.length === 0) {
    await adapter.postMessage(dest, { text: t('cmd.thread.noTemplates') });
    return;
  }
  const lines = [t('cmd.thread.templatesHeader')];
  for (const tpl of templates) {
    const agentList = tpl.agents.map(a => typeof a === 'string' ? a : a.ref).join(', ');
    lines.push(`• ${t('cmd.thread.templateLine', { name: tpl.name, description: tpl.description, agents: agentList })}`);
  }
  await adapter.postMessage(dest, { text: lines.join('\n') });
}

async function handleThreadAgents(channel: string, adapter: PlatformAdapter) {
  const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
  const agentDefs = listAgents();
  const lines: string[] = [];
  if (agentDefs.length > 0) {
    lines.push(t('cmd.thread.agentsTitle'));
    for (const a of agentDefs) {
      lines.push(`• ${t('cmd.thread.agentLine', { name: a.name, profile: a.profile, description: a.description || '' })}`);
    }
  } else {
    lines.push(t('cmd.thread.noAgents'));
  }
  const active = threadStore.findActive(channel);
  if (active) {
    lines.push('');
    lines.push(t('cmd.thread.activeThreadHeader', { id: active.id }));
    for (const [slotId, slot] of Object.entries(active.agents)) {
      const isActiveAgent = slotId === active.activeAgent ? ` ${Icons.arrowLeft}` : '';
      const sessionStr = slot.sessionName || t('cmd.thread.noSession');
      lines.push(`  • ${t('cmd.thread.slotLine', { slotId, profile: slot.profile, status: slot.status, session: sessionStr })}${isActiveAgent}`);
    }
  }
  await adapter.postMessage(dest, { text: lines.join('\n') });
}

async function handleThreadCancelAlias(channel: string, adapter: PlatformAdapter) {
  const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
  // Alias for !cancel — tear down every live execution on the channel as 'cancelled'
  // (record→cancelled, kill the handle, balanced event), matching the !cancel path.
  const execs = runRegistry.getByChannel(channel);
  for (const e of execs) {
    if (e.executionId) executionRegistry.teardownExecution({ executionId: e.executionId, status: 'cancelled', durationS: 0 });
    else runRegistry.killById(e.registryKey);
  }
  if (execs.length > 0) {
    log.info('Cancel requested for channel:', channel);
    conduitQueues.delete(channel);
    await adapter.postMessage(dest, { text: `${Icons.stopped} ${t('cmd.thread.cancelledSessionPreserved')}` });
  } else {
    await adapter.postMessage(dest, { text: t('cmd.thread.nothingRunning') });
  }
}

async function handleThreadList(channel: string, adapter: PlatformAdapter) {
  const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
  const threads = threadStore.findByChannel(channel).slice(0, 10);
  if (threads.length === 0) {
    await adapter.postMessage(dest, { text: t('cmd.thread.noThreadsChannel') });
    return;
  }
  const lines = [t('cmd.thread.recentHeader')];
  for (const thr of threads) {
    const modeLabel = thr.templateName || t('cmd.thread.adHoc');
    lines.push(`• ${t('cmd.thread.recentLine', { id: thr.id, mode: modeLabel, status: thr.status, steps: thr.steps.length, cost: thr.totalCostUsd.toFixed(4) })}`);
  }
  await adapter.postMessage(dest, { text: lines.join('\n') });
}

async function handleThreadListRunning(channel: string, adapter: PlatformAdapter) {
  const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
  const executions = runRegistry.getAll().filter(e => e.threadId);
  if (executions.length === 0) {
    await adapter.postMessage(dest, { text: t('cmd.thread.noRunning') });
    return;
  }
  const lines = [t('cmd.thread.runningHeader')];
  for (const exec of executions) {
    const thread = exec.threadId ? threadStore.get(exec.threadId) : null;
    const modeLabel = thread?.templateName || t('cmd.thread.adHoc');
    const stepCount = thread?.steps.length ?? 0;
    const cost = thread?.totalCostUsd ?? 0;
    lines.push(`• ${t('cmd.thread.runningLine', { id: exec.threadId ?? '', channel: exec.channel || '?', mode: modeLabel, steps: stepCount, cost: cost.toFixed(4) })}`);
  }
  await adapter.postMessage(dest, { text: lines.join('\n') });
}

async function sendThreadUsage(channel: string, adapter: PlatformAdapter) {
  const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
  await adapter.postMessage(dest, {
    text: [
      t('cmd.thread.usageHeader'),
      t('cmd.thread.usageStatus'),
      t('cmd.thread.usageAgents'),
      t('cmd.thread.usageTemplates'),
      t('cmd.thread.usageAdHoc'),
      t('cmd.thread.usageTemplate'),
      t('cmd.thread.usageAdd'),
      t('cmd.thread.usageCancel'),
      t('cmd.thread.usageList'),
      t('cmd.thread.usageListRunning'),
    ].join('\n'),
  });
}

export async function handleThreadCmd(channel: string, adapter: PlatformAdapter, msg: string) {
  const args = msg.replace(/^!thread\s*/, '').trim();
  if (!args) return handleThreadStatus(channel, adapter);
  if (args === 'templates') return handleThreadTemplates(channel, adapter);
  if (args === 'agents') return handleThreadAgents(channel, adapter);
  if (args === 'cancel') return handleThreadCancelAlias(channel, adapter);
  if (args === 'list') return handleThreadList(channel, adapter);
  if (args === 'list --running') return handleThreadListRunning(channel, adapter);
  return sendThreadUsage(channel, adapter);
}
