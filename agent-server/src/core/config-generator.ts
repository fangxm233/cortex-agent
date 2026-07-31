// input:  filesystem, config paths, server root
// output: full, restricted, platform MCP configs
// pos:    Generates declared MCP compositions
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { writeFileSync } from 'fs';
import * as path from 'path';
import { SERVER_ROOT, CONFIG_DIR } from '@core/utils.js';
import { createLogger } from '@core/log.js';

const log = createLogger('config-generator');

const MCP_CONFIG_PATH = path.join(CONFIG_DIR, 'mcp-config.json');
const CORE_MCP_CONFIG_PATH = path.join(CONFIG_DIR, 'mcp-config-core.json');
const TASKS_MCP_CONFIG_PATH = path.join(CONFIG_DIR, 'mcp-config-tasks.json');
const MANAGER_QA_MCP_CONFIG_PATH = path.join(CONFIG_DIR, 'mcp-config-manager-qa.json');
const THREAD_MCP_CONFIG_PATH = path.join(CONFIG_DIR, 'mcp-config-thread.json');
const EMPTY_MCP_CONFIG_PATH = path.join(CONFIG_DIR, 'mcp-config-empty.json');
const BENCHMARK_THREAD_MCP_CONFIG_PATH = path.join(CONFIG_DIR, 'mcp-config-benchmark-thread.json');
const TUI_MCP_CONFIG_PATH = path.join(CONFIG_DIR, 'mcp-config-tui.json');
const SLACK_MCP_CONFIG_PATH = path.join(CONFIG_DIR, 'mcp-config-slack.json');
const FEISHU_MCP_CONFIG_PATH = path.join(CONFIG_DIR, 'mcp-config-feishu.json');
const WEB_MCP_CONFIG_PATH = path.join(CONFIG_DIR, 'mcp-config-web.json');

/**
 * Build a MCP server entry. Uses absolute path in args as a workaround for
 * Claude Code 2.1.123: the `cwd` field in MCP config is NOT inherited by the
 * spawned process, so relative paths silently fail ("status":"failed").
 */
function serverEntry(script: string, serverRoot: string) {
  return {
    command: 'node',
    args: [path.join(serverRoot, script)],
    cwd: serverRoot,
  };
}

/** Direct-session config: always-on tools plus direct-only Cortex management. */
export function buildFullConfig(serverRoot: string): object {
  return {
    mcpServers: {
      'cortex-core': serverEntry('dist/domain/mcp/core-server.js', serverRoot),
      'cortex-tasks': serverEntry('dist/domain/mcp/tasks-server.js', serverRoot),
      'cortex-manager-qa': serverEntry('dist/domain/mcp/manager-qa-server.js', serverRoot),
      'cortex-ext': serverEntry('dist/domain/mcp/server.js', serverRoot),
    },
  };
}

/** Remote execution and time tools, isolated for restricted composition. */
export function buildCoreConfig(serverRoot: string): object {
  return {
    mcpServers: {
      'cortex-core': serverEntry('dist/domain/mcp/core-server.js', serverRoot),
    },
  };
}

/** Read-only task monitoring for top-level direct and thread sessions. */
export function buildTasksConfig(serverRoot: string): object {
  return {
    mcpServers: {
      'cortex-tasks': serverEntry('dist/domain/mcp/tasks-server.js', serverRoot),
    },
  };
}

/** Manager answer channel, loaded for top-level direct and thread sessions. */
export function buildManagerQaConfig(serverRoot: string): object {
  return {
    mcpServers: {
      'cortex-manager-qa': serverEntry('dist/domain/mcp/manager-qa-server.js', serverRoot),
    },
  };
}

/** Thread lifecycle control, loaded only for thread sessions. */
export function buildThreadConfig(serverRoot: string): object {
  return {
    mcpServers: {
      'cortex-thread': serverEntry('dist/domain/mcp/thread-server.js', serverRoot),
    },
  };
}

/** Strict empty composition with no declared MCP servers. */
export function buildEmptyConfig(): object {
  return { mcpServers: {} };
}

/** Benchmark composition declaration; the server implementation is supplied separately. */
export function buildBenchmarkThreadConfig(serverRoot: string): object {
  return {
    mcpServers: {
      'cortex-benchmark-thread': serverEntry('dist/domain/mcp/benchmark-thread-server.js', serverRoot),
    },
  };
}

/** TUI MCP config — loaded ONLY by Claude TUI-mode sessions (DR-0012). Isolated tool set:
 *  cortex_plan_enter / cortex_plan_exit / cortex_ask_user replace the native
 *  EnterPlanMode / ExitPlanMode / AskUserQuestion tools, which are excluded from --tools in TUI mode. */
export function buildTuiConfig(serverRoot: string): object {
  return {
    mcpServers: {
      'cortex-tui-bridge': serverEntry('dist/domain/mcp/tui-server.js', serverRoot),
    },
  };
}

/** Slack MCP config — layered ON TOP of the full config (via the variadic `--mcp-config`) only for
 *  sessions that originate from Slack (channel carries the `slack:` prefix). Isolated to the single
 *  cortex-slack server so it can be added/removed independently of the base config; the Claude adapter
 *  and the PI mcp-bridge each decide whether to load it based on the session's source channel. */
export function buildSlackConfig(serverRoot: string): object {
  return {
    mcpServers: {
      'cortex-slack': serverEntry('dist/domain/mcp/slack-server.js', serverRoot),
    },
  };
}

/** Feishu MCP config — layered ON TOP of the full config (via the variadic `--mcp-config`) only for
 *  sessions that originate from Feishu (channel carries the `feishu:` prefix). Isolated to the single
 *  cortex-feishu server so it can be added/removed independently of the base config; the Claude adapter
 *  and the PI mcp-bridge each decide whether to load it based on the session's source channel. */
export function buildFeishuConfig(serverRoot: string): object {
  return {
    mcpServers: {
      'cortex-feishu': serverEntry('dist/domain/mcp/feishu-server.js', serverRoot),
    },
  };
}

/** Web MCP config — layered ON TOP of the full config (via the variadic `--mcp-config`) only for
 *  sessions that originate from the Web UI (channel carries the `web:` prefix). Isolated to the single
 *  cortex-web server (send_file tool) so it can be added/removed independently of the base config; the
 *  Claude adapter decides whether to load it based on the session's source channel. */
export function buildWebConfig(serverRoot: string): object {
  return {
    mcpServers: {
      'cortex-web': serverEntry('dist/domain/mcp/web-server.js', serverRoot),
    },
  };
}

export function generateMcpConfig(): void {
  const configs: Array<[string, string, object]> = [
    ['full', MCP_CONFIG_PATH, buildFullConfig(SERVER_ROOT)],
    ['core', CORE_MCP_CONFIG_PATH, buildCoreConfig(SERVER_ROOT)],
    ['tasks', TASKS_MCP_CONFIG_PATH, buildTasksConfig(SERVER_ROOT)],
    ['manager-Q&A', MANAGER_QA_MCP_CONFIG_PATH, buildManagerQaConfig(SERVER_ROOT)],
    ['thread', THREAD_MCP_CONFIG_PATH, buildThreadConfig(SERVER_ROOT)],
    ['empty', EMPTY_MCP_CONFIG_PATH, buildEmptyConfig()],
    ['benchmark thread', BENCHMARK_THREAD_MCP_CONFIG_PATH, buildBenchmarkThreadConfig(SERVER_ROOT)],
    ['TUI', TUI_MCP_CONFIG_PATH, buildTuiConfig(SERVER_ROOT)],
    ['Slack', SLACK_MCP_CONFIG_PATH, buildSlackConfig(SERVER_ROOT)],
    ['Feishu', FEISHU_MCP_CONFIG_PATH, buildFeishuConfig(SERVER_ROOT)],
    ['Web', WEB_MCP_CONFIG_PATH, buildWebConfig(SERVER_ROOT)],
  ];
  for (const [label, configPath, config] of configs) {
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    log.info(`Generated ${label} MCP config at ${configPath}`);
  }
}
