// input:  MCP bundles, tool registrars, process environment
// output: One composition-scoped Cortex MCP stdio service
// pos:    Bundles selected Cortex tools into one child process
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BUNDLED_MCP_SERVER_NAME, parseMcpBundles, MCP_BUNDLES_ENV, type McpBundleName } from '@core/mcp-bundles.js';
import { registerGatedMcpTools } from '@core/mcp-tool-gate.js';
import { requestLoopbackJson } from '@core/loopback-http.js';
import { createLogger } from '@core/log.js';
import { isMainModule } from '@core/utils.js';
import { CORTEX_VERSION } from '@core/version.js';

const log = createLogger('mcp-bundled');
export type Registrar = (server: McpServer) => void;
type RegistrarLoader = () => Promise<Registrar>;
type BundleRegistrarLoader = (bundle: McpBundleName) => Promise<Registrar>;
type BundleFailureReporter = (bundle: McpBundleName, error: unknown) => void;

const coreLoader: RegistrarLoader = async () => {
  const [{ registerTaskOpsTools }, { registerTimeTools }] = await Promise.all([
    import('./tools/task-ops.js'), import('./tools/time.js'),
  ]);
  return server => { registerTaskOpsTools(server); registerTimeTools(server); };
};

const tasksLoader: RegistrarLoader = async () => {
  const { registerTaskMonitorTools } = await import('./tools/task-monitor.js');
  return registerTaskMonitorTools;
};

const managerQaLoader: RegistrarLoader = async () => {
  const { registerAnswerSubtaskTool } = await import('./tools/manager-qa.js');
  return registerAnswerSubtaskTool;
};

const threadLoader: RegistrarLoader = async () => {
  const [{ registerAskManagerTool }, { registerThreadTools }] = await Promise.all([
    import('./tools/manager-qa.js'), import('./tools/thread-ops.js'),
  ]);
  return server => { registerThreadTools(server); registerAskManagerTool(server); };
};

const extLoader: RegistrarLoader = async () => {
  const [{ registerCostTools }, { registerExecutionTools }, { registerContextTools },
    { registerScheduleTools }, { executionRepo }] = await Promise.all([
    import('./tools/cost.js'), import('./tools/executions.js'), import('./tools/context.js'),
    import('./tools/schedule.js'), import('@store/execution-repo.js'),
  ]);
  executionRepo.load();
  return server => {
    registerCostTools(server); registerExecutionTools(server);
    registerContextTools(server); registerScheduleTools(server);
  };
};

function interactionPost(url: string, body: any): Promise<{ status: number; body: any }> {
  return requestLoopbackJson('POST', url, body, {
    'x-cortex-token': process.env.CORTEX_WEBHOOK_TOKEN || '',
  });
}

const interactionLoader: RegistrarLoader = async () => {
  const [{ registerInteractionPlanTools }, { registerInteractionAskTools }] = await Promise.all([
    import('./tools/interaction-plan.js'), import('./tools/interaction-ask.js'),
  ]);
  const port = parseInt(process.env.WEBHOOK_PORT || '3001', 10);
  const deps = {
    channel: process.env.SLACK_CHANNEL ?? null,
    sessionId: process.env.CORTEX_SESSION_ID ?? null,
    threadId: process.env.CORTEX_THREAD_ID ?? null,
    webhookBaseUrl: `http://127.0.0.1:${port}`,
    httpPost: interactionPost,
  };
  return server => { registerInteractionPlanTools(server, deps); registerInteractionAskTools(server, deps); };
};

const slackLoader: RegistrarLoader = async () => {
  const [{ WebClient }, { registerSlackTools }] = await Promise.all([
    import('@slack/web-api'), import('./tools/slack.js'),
  ]);
  const token = process.env.SLACK_BOT_TOKEN;
  const slack = token ? new WebClient(token) : null;
  return server => registerSlackTools(server, {
    slack,
    fallbackChannel: process.env.SLACK_CHANNEL,
    branchMachine: process.env.CORTEX_BRANCH_MACHINE,
    callbackSource: process.env.CORTEX_CALLBACK_SOURCE,
  });
};

const feishuLoader: RegistrarLoader = async () => {
  const [{ registerFeishuTools }, { buildFeishuClientFromEnv }] = await Promise.all([
    import('./feishu/index.js'), import('./feishu/client.js'),
  ]);
  const client = buildFeishuClientFromEnv();
  return server => registerFeishuTools(server, { client });
};

const webLoader: RegistrarLoader = async () => {
  const [{ registerUiFileTools }, { registerUiViewTools }, { registerUiDecisionTools }] = await Promise.all([
    import('./tools/ui-file.js'), import('./tools/ui-view.js'), import('./tools/ui-decision.js'),
  ]);
  return server => {
    registerUiFileTools(server); registerUiViewTools(server); registerUiDecisionTools(server);
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
  load: BundleRegistrarLoader = bundle => LOADERS[bundle](),
  report: BundleFailureReporter = reportBundleFailure,
): Promise<Registrar[]> {
  const settled = await Promise.all(bundles.map(async bundle => {
    try {
      const registrar = await load(bundle);
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

export async function createBundledServer(bundles: readonly McpBundleName[]): Promise<McpServer> {
  const registrars = await loadBundleRegistrars(bundles);
  const server = new McpServer({ name: BUNDLED_MCP_SERVER_NAME, version: CORTEX_VERSION });
  registerGatedMcpTools(server, target => registrars.forEach(register => register(target)));
  return server;
}

export async function startServer(): Promise<void> {
  const selection = process.env[MCP_BUNDLES_ENV] ?? process.argv[2];
  const bundles = parseMcpBundles(selection);
  const server = await createBundledServer(bundles);
  await server.connect(new StdioServerTransport());
}

if (isMainModule(import.meta.url)) {
  startServer().catch((error) => {
    log.error(error);
    process.exit(1);
  });
}
