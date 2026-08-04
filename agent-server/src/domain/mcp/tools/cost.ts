// input:  McpServer, cost-repo, cost-tracker
// output: cost_query tool registration (optional projectId scope)
// pos:    MCP tool for querying current cost and budget status, global or per-project
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getCostSummary, pickBudget } from '../../costs/cost-tracker.js';
import { costRepo } from '@store/cost-repo.js';

export function registerCostTools(server: McpServer): void {
  server.tool(
    'cost_query',
    'Query current cost and budget status. Returns today/month spending, budget limits, remaining budget, api/plan cost split, source breakdown (gateway vs estimate), and token usage. Pass projectId to scope both the spend and the budget limits to one project.',
    {
      projectId: z.string().optional().describe('Scope the report to one project. Omit for the global view.'),
    },
    { readOnlyHint: true },
    async ({ projectId }: { projectId?: string }) => {
      try {
        const scope = projectId ?? null;
        const budgetConfig = await costRepo.readBudget();
        const budget = pickBudget(budgetConfig, scope);
        const summaryData = await getCostSummary(scope);

        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
        const monthStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;

        const todayTotal = summaryData.byMode.today.total;
        const monthTotal = summaryData.byMode.month.total;
        const todayApi = summaryData.byMode.today.api;
        const todayPlan = summaryData.byMode.today.plan;
        const monthApi = summaryData.byMode.month.api;
        const monthPlan = summaryData.byMode.month.plan;

        const dailyPct = ((todayTotal / budget.daily_usd) * 100).toFixed(1);
        const monthlyPct = ((monthTotal / budget.monthly_usd) * 100).toFixed(1);

        const scopeLabel = budget.scope === 'project' ? 'per-project budget' : 'global budget';
        const lines = [
          scope
            ? `Project: ${scope} (${scopeLabel})`
            : 'Scope: all projects (global budget)',
          `Today (${todayStr}): $${todayTotal.toFixed(2)} / $${budget.daily_usd} (${dailyPct}%, ${summaryData.entryCount} sessions in window)`,
          `  API: $${todayApi.toFixed(2)} | Plan: $${todayPlan.toFixed(2)}`,
          `Month (${monthStr}): $${monthTotal.toFixed(2)} / $${budget.monthly_usd} (${monthlyPct}%)`,
          `  API: $${monthApi.toFixed(2)} | Plan: $${monthPlan.toFixed(2)}`,
          `Remaining today: $${(budget.daily_usd - todayTotal).toFixed(2)}`,
          `Remaining month: $${(budget.monthly_usd - monthTotal).toFixed(2)}`,
        ];

        // Source breakdown
        if (summaryData.bySource && Object.keys(summaryData.bySource).length > 0) {
          lines.push('');
          lines.push('By source:');
          for (const [src, stats] of Object.entries(summaryData.bySource) as [string, { today: number; month: number }][]) {
            lines.push(`  ${src}: today $${stats.today.toFixed(2)} | month $${stats.month.toFixed(2)}`);
          }
        }

        // Token usage
        const tok = summaryData.tokens;
        if (tok && (tok.total.input > 0 || tok.total.output > 0)) {
          const fmtTok = (n: number) => n >= 1e6 ? `${(n/1e6).toFixed(1)}M` : n >= 1e3 ? `${(n/1e3).toFixed(1)}k` : String(n);
          lines.push('');
          lines.push(`Tokens today: ${fmtTok(tok.today.input)} in / ${fmtTok(tok.today.output)} out`);
          lines.push(`Tokens month: ${fmtTok(tok.month.input)} in / ${fmtTok(tok.month.output)} out`);
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Failed to query cost: ${(e as Error).message}` }], isError: true };
      }
    }
  );
}
