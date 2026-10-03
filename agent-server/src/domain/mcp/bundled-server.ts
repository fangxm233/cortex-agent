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
  const [{ registerRemoteOpsTools }, { registerTimeTools }, { registerSubagentTools }] = await Promise.all([
    import('./tools/remote-ops.js'), import('./tools/time.js'), import('./tools/subagent.js'),
  ]);
  return server => {
    registerRemoteOpsTools(server, ctx); registerTimeTools(server); registerSubagentTools(server, ctx);
  };
};

const extLoader: RegistrarLoader = async (ctx) => {
  const [{ registerCostTools }, { registerExecutionTools }, { registerContextTools },
    { registerScheduleTools }, { registerWaitpointTools }] = await Promise.all([
    import('./tools/cost.js'), import('./tools/executions.js'), import('./tools/context.js'),
    import('./tools/schedule.js'), import('./tools/waitpoint.js'),
  ]);
  return server => {
    registerCostTools(server); registerExecutionTools(server);
    registerContextTools(server, ctx); registerScheduleTools(server, ctx);
    registerWaitpointTools(server, ctx);
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
  const [{ registerFileTools }, { buildFeishuClientFromEnv }] = await Promise.all([
    import('./feishu/file.js'), import('./feishu/client.js'),
  ]);
  // App credentials stay process-wide (one Feishu app per daemon); only the channel is per session.
  const client = buildFeishuClientFromEnv();
  return server => registerFileTools(server, { client, fallbackChannel: ctx.channel, ctx });
};

const webLoader: RegistrarLoader = async (ctx) => {
  const [{ registerUiFileTools }, { registerUiViewTools }, { registerUiDecisionTools }] = await Promise.all([
    import('./tools/ui-file.js'), import('./tools/ui-view.js'), import('./tools/ui-decision.js'),
  ]);
  return server => {
    registerUiFileTools(server, ctx); registerUiViewTools(server, ctx); registerUiDecisionTools(server, ctx);
  };
};

const workersLoader: RegistrarLoader = async (ctx) => {
  const { registerWorkerTools } = await import('./tools/workers.js');
  return server => registerWorkerTools(server, ctx);
};

const LOADERS: Record<McpBundleName, RegistrarLoader> = {
  'cortex-core': coreLoader,
  'cortex-ext': extLoader,
  'cortex-interaction-bridge': interactionLoader,
  'cortex-slack': slackLoader,
  'cortex-feishu': feishuLoader,
  'cortex-web': webLoader,
  'cortex-workers': workersLoader,
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
  // Only this process reads the execution store from the file: the daemon writes it while the
  // session runs, so every read follows the file instead of a copy taken at startup. This belongs
  // here rather than in the ext bundle because the in-process host shares the daemon's own
  // repository, which is live already and must not re-read the file (that would drop whatever it
  // still has queued to write).
  if (bundles.includes('cortex-ext')) {
    const { executionRepo } = await import('@store/execution-repo.js');
    executionRepo.follow();
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

/** The `OpenBundledMcpServer` port `agent-adapter/pi/mcp-bridge.ts` declares: bundles plus the
 *  session env, with the tool context derived here rather than there (D10 — deriving it reaches
 *  the session registry and the subagent catalog). Injected at `domain/runs/adapters.ts`. */
export async function openBundledMcpServer(
  bundles: McpBundleName[],
  env: Record<string, string>,
): Promise<McpServer> {
  // A PI session's env never carries the model catalogs a Claude sidecar is handed at spawn; this
  // runs inside the daemon, so read the same caches directly. Loaded lazily: the stdio entry above
  // must not pull in the Claude adapter.
  const { subagentModelEnv } = await import('../../agent-adapter/claude/spawn-args.js');
  return createBundledServer(bundles, toolContextFromEnv({ ...subagentModelEnv(), ...env }));
}
