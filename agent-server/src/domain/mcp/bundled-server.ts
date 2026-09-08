// input:  MCP bundles, tool registrars, one session tool context (from env for the stdio entry)
// output: One composition-scoped Cortex MCP server, served over stdio when run as an entry
// pos:    Bundles selected Cortex tools against one session context
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BUNDLED_MCP_SERVER_NAME, parseMcpBundles, MCP_BUNDLES_ENV, type McpBundleName } from '@core/mcp-bundles.js';
import { registerGatedMcpTools } from '@core/mcp-tool-gate.js';
import { createLogger } from '@core/log.js';
import { isMainModule } from '@core/utils.js';
import { CORTEX_VERSION } from '@core/version.js';
import { toolContextFromEnv, type CortexToolContext } from './tools/context.js';

const log = createLogger('mcp-bundled');
export type Registrar = (server: McpServer) => void;
type RegistrarLoader = (ctx: CortexToolContext) => Promise<Registrar>;
type BundleRegistrarLoader = (bundle: McpBundleName, ctx: CortexToolContext) => Promise<Registrar>;
type BundleFailureReporter = (bundle: McpBundleName, error: unknown) => void;

const coreLoader: RegistrarLoader = async (ctx) => {
  const [{ registerTaskOpsTools }, { registerTimeTools }] = await Promise.all([
    import('./tools/task-ops.js'), import('./tools/time.js'),
  ]);
  return server => { registerTaskOpsTools(server, ctx); registerTimeTools(server); };
};

const tasksLoader: RegistrarLoader = async (ctx) => {
  const { registerTaskMonitorTools } = await import('./tools/task-monitor.js');
  return server => registerTaskMonitorTools(server, ctx);
};

const managerQaLoader: RegistrarLoader = async (ctx) => {
  const { registerAnswerSubtaskTool } = await import('./tools/manager-qa.js');
  return server => registerAnswerSubtaskTool(server, ctx);
};

const threadLoader: RegistrarLoader = async (ctx) => {
  const [{ registerAskManagerTool }, { registerThreadTools }] = await Promise.all([
    import('./tools/manager-qa.js'), import('./tools/thread-ops.js'),
  ]);
  return server => { registerThreadTools(server, ctx); registerAskManagerTool(server, ctx); };
};

const extLoader: RegistrarLoader = async (ctx) => {
  const [{ registerCostTools }, { registerExecutionTools }, { registerContextTools },
    { registerScheduleTools }] = await Promise.all([
    import('./tools/cost.js'), import('./tools/executions.js'), import('./tools/context.js'),
    import('./tools/schedule.js'),
  ]);
  return server => {
    registerCostTools(server); registerExecutionTools(server);
    registerContextTools(server, ctx); registerScheduleTools(server, ctx);
  };
};

const interactionLoader: RegistrarLoader = async (ctx) => {
  const [{ registerInteractionPlanTools, interactionDepsFor }, { registerCommissionTools }, { registerInteractionAskTools }] = await Promise.all([
    import('./tools/interaction-plan.js'), import('./tools/commission-tools.js'), import('./tools/interaction-ask.js'),
  ]);
  const deps = interactionDepsFor(ctx);
  return server => {
    registerInteractionPlanTools(server, deps);
    registerCommissionTools(server, deps);
    registerInteractionAskTools(server, deps);
  };
};

const slackLoader: RegistrarLoader = async (ctx) => {
  const { registerSlackTools, slackDepsFor } = await import('./tools/slack.js');
  const deps = slackDepsFor(ctx);
  return server => registerSlackTools(server, deps);
};

const feishuLoader: RegistrarLoader = async (ctx) => {
  const [{ registerFeishuTools }, { buildFeishuClientFromEnv }] = await Promise.all([
    import('./feishu/index.js'), import('./feishu/client.js'),
  ]);
  // App credentials stay process-wide (one Feishu app per daemon); only the channel is per session.
  const client = buildFeishuClientFromEnv();
  return server => registerFeishuTools(server, { client, fallbackChannel: ctx.channel });
};

const webLoader: RegistrarLoader = async (ctx) => {
  const [{ registerUiFileTools }, { registerUiViewTools }, { registerUiDecisionTools }] = await Promise.all([
    import('./tools/ui-file.js'), import('./tools/ui-view.js'), import('./tools/ui-decision.js'),
  ]);
  return server => {
    registerUiFileTools(server, ctx); registerUiViewTools(server, ctx); registerUiDecisionTools(server, ctx);
  };
};

const LOADERS: Record<McpBundleName, RegistrarLoader> = {
  'cortex-core': coreLoader,
  'cortex-tasks': tasksLoader,
  'cortex-manager-qa': managerQaLoader,
  'cortex-thread': threadLoader,
  'cortex-ext': extLoader,
  'cortex-interaction-bridge': interactionLoader,
  'cortex-slack': slackLoader,
  'cortex-feishu': feishuLoader,
  'cortex-web': webLoader,
};

function reportBundleFailure(bundle: McpBundleName, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  log.error(`Skipping MCP bundle ${bundle}: ${message}`);
}

export async function loadBundleRegistrars(
  bundles: readonly McpBundleName[],
  ctx: CortexToolContext,
  load: BundleRegistrarLoader = (bundle, context) => LOADERS[bundle](context),
  report: BundleFailureReporter = reportBundleFailure,
): Promise<Registrar[]> {
  const settled = await Promise.all(bundles.map(async bundle => {
    try {
      const registrar = await load(bundle, ctx);
      return (server: McpServer) => {
        try {
          registrar(server);
        } catch (error) {
          report(bundle, error);
        }
      };
    } catch (error) {
      report(bundle, error);
      return null;
    }
  }));
  return settled.filter((registrar): registrar is Registrar => registrar !== null);
}

/**
 * One McpServer carrying the selected bundles, every tool bound to `ctx`. The stdio entry builds
 * `ctx` from its environment; an in-process host may build many, one per session, and connect
 * each server over its own transport.
 */
export async function createBundledServer(
  bundles: readonly McpBundleName[],
  ctx: CortexToolContext,
): Promise<McpServer> {
  const registrars = await loadBundleRegistrars(bundles, ctx);
  const server = new McpServer({ name: BUNDLED_MCP_SERVER_NAME, version: CORTEX_VERSION });
  registerGatedMcpTools(server, target => registrars.forEach(register => register(target)), ctx.toolAllowlist);
  return server;
}

export async function startServer(): Promise<void> {
  const selection = process.env[MCP_BUNDLES_ENV] ?? process.argv[2];
  const bundles = parseMcpBundles(selection);
  // Only this process needs the execution store filled: nothing else populated it. Loading
  // belongs here rather than in the ext bundle because the in-process host shares one daemon-wide
  // repository — the daemon loads it at boot and keeps writing to it, so a per-session reload
  // there re-read the file on every session start and dropped whatever was still queued to write.
  if (bundles.includes('cortex-ext')) {
    const { executionRepo } = await import('@store/execution-repo.js');
    executionRepo.load();
  }
  const server = await createBundledServer(bundles, toolContextFromEnv());
  await server.connect(new StdioServerTransport());
}

if (isMainModule(import.meta.url)) {
  startServer().catch((error) => {
    log.error(error);
    process.exit(1);
  });
}
