// input:  fs, path, SERVER_ROOT, CONFIG_DIR
// output: generateMcpConfig — writes mcp-config.json to config dir
// pos:    Startup-time MCP config auto-generation (P4)

import { writeFileSync } from 'fs';
import * as path from 'path';
import { SERVER_ROOT, CONFIG_DIR } from '@core/utils.js';
import { createLogger } from '@core/log.js';

const log = createLogger('config-generator');

const MCP_CONFIG_PATH = path.join(CONFIG_DIR, 'mcp-config.json');
const CORE_MCP_CONFIG_PATH = path.join(CONFIG_DIR, 'mcp-config-core.json');
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

/** Full MCP config with both servers — loaded by user-initiated (direct) sessions. */
export function buildFullConfig(serverRoot: string): object {
  return {
    mcpServers: {
      'cortex-core': serverEntry('dist/domain/mcp/core-server.js', serverRoot),
      'cortex-ext': serverEntry('dist/domain/mcp/server.js', serverRoot),
    },
  };
}

/** Core-only MCP config — loaded by thread sessions (only remote_* tools). */
export function buildCoreConfig(serverRoot: string): object {
  return {
    mcpServers: {
      'cortex-core': serverEntry('dist/domain/mcp/core-server.js', serverRoot),
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
  writeFileSync(MCP_CONFIG_PATH, JSON.stringify(buildFullConfig(SERVER_ROOT), null, 2));
  log.info(`Generated full MCP config at ${MCP_CONFIG_PATH}`);

  writeFileSync(CORE_MCP_CONFIG_PATH, JSON.stringify(buildCoreConfig(SERVER_ROOT), null, 2));
  log.info(`Generated core MCP config at ${CORE_MCP_CONFIG_PATH}`);

  writeFileSync(TUI_MCP_CONFIG_PATH, JSON.stringify(buildTuiConfig(SERVER_ROOT), null, 2));
  log.info(`Generated TUI MCP config at ${TUI_MCP_CONFIG_PATH}`);

  writeFileSync(SLACK_MCP_CONFIG_PATH, JSON.stringify(buildSlackConfig(SERVER_ROOT), null, 2));
  log.info(`Generated Slack MCP config at ${SLACK_MCP_CONFIG_PATH}`);

  writeFileSync(FEISHU_MCP_CONFIG_PATH, JSON.stringify(buildFeishuConfig(SERVER_ROOT), null, 2));
  log.info(`Generated Feishu MCP config at ${FEISHU_MCP_CONFIG_PATH}`);

  writeFileSync(WEB_MCP_CONFIG_PATH, JSON.stringify(buildWebConfig(SERVER_ROOT), null, 2));
  log.info(`Generated Web MCP config at ${WEB_MCP_CONFIG_PATH}`);
}
