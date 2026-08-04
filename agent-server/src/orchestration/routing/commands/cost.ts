// input:  !cost / !budget chat commands
// output: cost report and global / per-project budget display + edit
// pos:    chat surface over domain/costs/cost-tracker budget resolution
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { Destination, PlatformAdapter } from '@platform/index.js';
import {
  formatCostReport, checkBudget, setBudget, clearProjectBudget, listProjectBudgets,
} from '@domain/costs/cost-tracker.js';
import { projectStore } from '@domain/projects/index.js';
import { Icons } from '../../../core/icons.js';
import { t } from '../../../core/i18n.js';

/** Reserved sub-commands; a project literally named `list` or `clear` is not addressable here. */
const RESERVED = new Set(['list', 'clear', 'reset']);

/** An amount token: `$50/d` / `1000/m`. Everything else in argument position is a project id. */
function isAmountToken(token: string): boolean {
  return token.includes('/d') || token.includes('/m');
}

function parseAmount(args: string[], suffix: '/d' | '/m'): number | undefined {
  const raw = args.find(a => a.includes(suffix))?.replace(/[^\d.]/g, '');
  if (!raw) return undefined;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export async function handleCostCmd(channel: string, adapter: PlatformAdapter, trimmedMessage: string): Promise<void> {
  const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
  const project = trimmedMessage.split(/\s+/).slice(1).join(' ').trim() || null;
  await adapter.postMessage(dest, { text: await formatCostReport(project) });
}

/**
 * `!budget`                          — global status
 * `!budget $50/d $1000/m`            — set the global limits
 * `!budget list`                     — global limits + every per-project override
 * `!budget <project>`                — that project's status (own override or inherited globals)
 * `!budget <project> $50/d $1000/m`  — set that project's override (both limits required)
 * `!budget <project> clear`          — drop that project's override
 */
export async function handleBudgetCmd(channel: string, adapter: PlatformAdapter, trimmedMessage: string): Promise<void> {
  const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
  const post = (text: string) => adapter.postMessage(dest, { text });
  const args = trimmedMessage.split(/\s+/).slice(1).filter(a => a.length > 0);

  const first = args[0]?.toLowerCase();
  if (first === 'list') {
    await post(await formatBudgetList());
    return;
  }

  // The project selector is the leading non-amount token; without one this is the global form.
  const project = args.length > 0 && !isAmountToken(args[0]) && !RESERVED.has(first!) ? args[0] : null;
  if (project && !projectStore.exists(project)) {
    const known = projectStore.list().map(p => p.id).join(', ');
    await post(`${Icons.error} ${t('cmd.cost.budgetUnknownProject', { project, known })}`);
    return;
  }

  const rest = project ? args.slice(1) : args;

  if (rest.length === 0) {
    await post(await formatBudgetStatus(project));
    return;
  }

  if (project && RESERVED.has(rest[0].toLowerCase())) {
    const removed = await clearProjectBudget(project);
    await post(removed
      ? `${Icons.ok} ${t('cmd.cost.budgetCleared', { project })}`
      : t('cmd.cost.budgetNoOverride', { project }));
    return;
  }

  const daily = parseAmount(rest, '/d');
  const monthly = parseAmount(rest, '/m');

  // Per-project overrides are pair-only — a half-set override would resolve against a limit
  // the project never declared. The global form still accepts a single limit (existing behaviour),
  // but arguments that parse to no limit at all are a usage error, not a no-op write.
  if (project ? (daily == null || monthly == null) : (daily == null && monthly == null)) {
    await post(`${Icons.error} ${t('cmd.cost.budgetPairRequired', { project: project ?? '<project>' })}`);
    return;
  }

  const result = await setBudget({ daily_usd: daily, monthly_usd: monthly, project });
  await post(`${Icons.ok} ${project
    ? t('cmd.cost.budgetUpdatedProject', { project, daily: result.daily_usd, monthly: result.monthly_usd })
    : t('cmd.cost.budgetUpdated', { daily: result.daily_usd, monthly: result.monthly_usd })}`);
}

async function formatBudgetStatus(project: string | null): Promise<string> {
  const b = await checkBudget(project);
  const vars = {
    dailyBudget: b.dailyBudget,
    dailySpent: b.dailySpent.toFixed(2),
    dailyRemaining: b.dailyRemaining.toFixed(2),
    monthlyBudget: b.monthlyBudget,
    monthlySpent: b.monthlySpent.toFixed(2),
    monthlyRemaining: b.monthlyRemaining.toFixed(2),
  };
  if (!project) return t('cmd.cost.budgetHeader', vars);
  const scope = t(b.scope === 'project' ? 'cmd.cost.budgetScopeProject' : 'cmd.cost.budgetScopeGlobal');
  return t('cmd.cost.budgetHeaderProject', { ...vars, project, scope });
}

async function formatBudgetList(): Promise<string> {
  const global = await checkBudget();
  const overrides = await listProjectBudgets();
  const lines = [t('cmd.cost.budgetListHeader', { daily: global.dailyBudget, monthly: global.monthlyBudget })];
  if (overrides.length === 0) {
    lines.push(t('cmd.cost.budgetListEmpty'));
  } else {
    for (const o of overrides) {
      lines.push(t('cmd.cost.budgetListItem', { project: o.project, daily: o.daily_usd, monthly: o.monthly_usd }));
    }
  }
  return lines.join('\n');
}
