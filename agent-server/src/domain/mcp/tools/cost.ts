import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getCostSummary, formatTokens } from '../../costs/cost-tracker.js';

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
        const summaryData = await getCostSummary(scope);
        const { dailyBudget, monthlyBudget, budgetScope } = summaryData;

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

        const dailyPct = ((todayTotal / dailyBudget) * 100).toFixed(1);
        const monthlyPct = ((monthTotal / monthlyBudget) * 100).toFixed(1);

        const scopeLabel = budgetScope === 'project' ? 'per-project budget' : 'global budget';
        const lines = [
          scope
            ? `Project: ${scope} (${scopeLabel})`
            : 'Scope: all projects (global budget)',
          `Today (${todayStr}): $${todayTotal.toFixed(2)} / $${dailyBudget} (${dailyPct}%, ${summaryData.entryCount} sessions in window)`,
          `  API: $${todayApi.toFixed(2)} | Plan: $${todayPlan.toFixed(2)}`,
          `Month (${monthStr}): $${monthTotal.toFixed(2)} / $${monthlyBudget} (${monthlyPct}%)`,
          `  API: $${monthApi.toFixed(2)} | Plan: $${monthPlan.toFixed(2)}`,
          `Remaining today: $${(dailyBudget - todayTotal).toFixed(2)}`,
          `Remaining month: $${(monthlyBudget - monthTotal).toFixed(2)}`,
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
          lines.push('');
          lines.push(`Tokens today: ${formatTokens(tok.today.input)} in / ${formatTokens(tok.today.output)} out`);
          lines.push(`Tokens month: ${formatTokens(tok.month.input)} in / ${formatTokens(tok.month.output)} out`);
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Failed to query cost: ${(e as Error).message}` }], isError: true };
      }
    }
  );
}
