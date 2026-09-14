import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { executionRepo, type ExecutionRecord } from '@store/execution-repo.js';

function formatDuration(ms: number): string {
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

function formatRecord(r: ExecutionRecord, now: number, detail = false): string {
  const startMs = r.runtime?.startedAt ? new Date(r.runtime.startedAt).getTime() : 0;
  const elapsed = r.status === 'running' ? formatDuration(now - startMs) : (r.metrics?.durationS ? formatDuration(r.metrics.durationS * 1000) : '—');
  const cost = r.metrics?.costUsd != null ? `$${r.metrics.costUsd.toFixed(4)}` : '—';
  const turns = r.metrics?.numTurns ?? '—';
  const machine = r.dispatch?.machine || '—';
  const taskId = r.dispatch?.taskId || '—';
  const taskHash = r.dispatch?.taskHash || '—';

  const lines = [
    `[${r.id}] ${r.status} (${r.kind})`,
    `  Project: ${r.project || '—'} | Machine: ${machine}`,
    `  Task ID: ${taskId} | Hash: ${taskHash}`,
    `  Elapsed: ${elapsed} | Cost: ${cost} | Turns: ${turns}`,
  ];
  if (r.text?.label) lines.push(`  Label: ${r.text.label}`);
  if (detail) {
    if (r.runtime?.startedAt) lines.push(`  Started: ${r.runtime.startedAt}`);
    if (r.runtime?.endedAt) lines.push(`  Ended: ${r.runtime.endedAt}`);
    if (r.dispatch?.sessionName) lines.push(`  Session: ${r.dispatch.sessionName}`);
    if (r.dispatch?.tmuxName) lines.push(`  Tmux: ${r.dispatch.tmuxName}`);
    if (r.text?.error) lines.push(`  Error: ${r.text.error}`);
    if (r.text?.finalOutput) lines.push(`  Output: ${r.text.finalOutput.slice(0, 500)}`);
  }
  return lines.join('\n');
}

export function registerExecutionTools(server: McpServer): void {
  server.tool(
    'query_executions',
    'Query execution status. List filtered executions, or look up a specific one by execution ID or dispatch task ID.',
    {
      execution_id: z.string().optional().describe('Look up by execution ID (exec_dispatch_xxx)'),
      task_id: z.string().optional().describe('Look up by dispatch task ID or TASKS.yaml hash'),
      status: z.enum(['running', 'completed', 'failed', 'cancelled', 'stale', 'all']).optional().describe('Filter by status (default: running)'),
      project: z.string().optional().describe('Filter by project'),
      limit: z.number().optional().describe('Max results (default: 10)'),
    },
    { readOnlyHint: true },
    async ({ execution_id, task_id, status, project, limit }: {
      execution_id?: string; task_id?: string; status?: string; project?: string; limit?: number;
    }) => {
      try {
        const records = executionRepo.getAllExecutions();
        const now = Date.now();

        // Single lookup mode
        if (execution_id) {
          const r = executionRepo.getExecution(execution_id);
          if (!r) return { content: [{ type: 'text', text: `No execution found: ${execution_id}` }], isError: true };
          return { content: [{ type: 'text', text: formatRecord(r, now, true) }] };
        }
        if (task_id) {
          const r = executionRepo.getExecutionByTaskId(task_id) || records.find(r => r.dispatch?.taskHash === task_id);
          if (!r) return { content: [{ type: 'text', text: `No execution found for task: ${task_id}` }], isError: true };
          return { content: [{ type: 'text', text: formatRecord(r, now, true) }] };
        }

        // List mode
        const filterStatus = status || 'running';
        let filtered = filterStatus === 'all' ? records : records.filter(r => r.status === filterStatus);
        if (project) filtered = filtered.filter(r => r.project === project);
        filtered.sort((a, b) => {
          const ta = a.runtime?.startedAt ? new Date(a.runtime.startedAt).getTime() : 0;
          const tb = b.runtime?.startedAt ? new Date(b.runtime.startedAt).getTime() : 0;
          return tb - ta;
        });
        const maxResults = limit || 10;
        const truncated = filtered.length > maxResults;
        filtered = filtered.slice(0, maxResults);

        if (filtered.length === 0) {
          return { content: [{ type: 'text', text: `No ${filterStatus} executions found.` }] };
        }

        const header = `${filterStatus === 'all' ? 'All' : filterStatus} executions: ${filtered.length}${truncated ? ` (showing first ${maxResults})` : ''}`;
        const body = filtered.map(r => formatRecord(r, now)).join('\n\n');
        return { content: [{ type: 'text', text: `${header}\n\n${body}` }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Failed to query executions: ${(e as Error).message}` }], isError: true };
      }
    }
  );
}
