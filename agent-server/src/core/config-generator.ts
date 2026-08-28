// input:  Filesystem, config paths, MCP bundles and gates
// output: Scoped configs and collapsed per-process MCP compositions
// pos:    Generates and materializes MCP configurations
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import { SERVER_ROOT, CONFIG_DIR } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import {
  BUNDLED_MCP_SERVER_NAME, encodeMcpBundles, MCP_BUNDLES_ENV,
  parseMcpBundles, type McpBundleName,
} from './mcp-bundles.js';
import {
  canonicalizeMcpToolAllowlist, MCP_TOOL_ALLOWLIST_ENV, MCP_TOOLS_BY_SERVER,
  validateMcpToolAllowlist,
} from './mcp-tool-gate.js';

const log = createLogger('config-generator');

const MCP_CONFIG_PATH = path.join(CONFIG_DIR, 'mcp-config.json');
const CORE_MCP_CONFIG_PATH = path.join(CONFIG_DIR, 'mcp-config-core.json');
const TASKS_MCP_CONFIG_PATH = path.join(CONFIG_DIR, 'mcp-config-tasks.json');
const MANAGER_QA_MCP_CONFIG_PATH = path.join(CONFIG_DIR, 'mcp-config-manager-qa.json');
const THREAD_MCP_CONFIG_PATH = path.join(CONFIG_DIR, 'mcp-config-thread.json');
const EMPTY_MCP_CONFIG_PATH = path.join(CONFIG_DIR, 'mcp-config-empty.json');
const INTERACTION_MCP_CONFIG_PATH = path.join(CONFIG_DIR, 'mcp-config-interaction.json');
const SLACK_MCP_CONFIG_PATH = path.join(CONFIG_DIR, 'mcp-config-slack.json');
const FEISHU_MCP_CONFIG_PATH = path.join(CONFIG_DIR, 'mcp-config-feishu.json');
const WEB_MCP_CONFIG_PATH = path.join(CONFIG_DIR, 'mcp-config-web.json');

/**
 * Build a MCP server entry. Uses absolute path in args as a workaround for
 * Claude Code 2.1.123: the `cwd` field in MCP config is NOT inherited by the
 * spawned process, so relative paths silently fail ("status":"failed").
 */
function serverEntry(script: string, serverRoot: string, env?: Record<string, string>) {
  return {
    command: 'node',
    args: [path.join(serverRoot, script)],
    cwd: serverRoot,
    ...(env ? { env } : {}),
  };
}

function bundledServerEntry(bundles: readonly McpBundleName[], serverRoot: string) {
  const entry = serverEntry('dist/domain/mcp/bundled-server.js', serverRoot);
  return { ...entry, args: [...entry.args, encodeMcpBundles(bundles)] };
}

interface McpServerEntry {
  env?: Record<string, string>;
  [key: string]: unknown;
}

interface McpConfigDocument {
  mcpServers: Record<string, McpServerEntry>;
}

function readMcpConfig(configPath: string): McpConfigDocument {
  return JSON.parse(readFileSync(configPath, 'utf8')) as McpConfigDocument;
}

function entryBundles(entry: McpServerEntry): McpBundleName[] | null {
  const envSelection = entry.env?.[MCP_BUNDLES_ENV];
  if (envSelection !== undefined) return parseMcpBundles(envSelection);
  const args = Array.isArray(entry.args) ? entry.args : [];
  const executable = typeof args[0] === 'string' ? args[0].replaceAll('\\', '/') : '';
  const isBundled = path.basename(executable) === 'bundled-server.js';
  return isBundled && typeof args[1] === 'string' ? parseMcpBundles(args[1]) : null;
}

function knownToolsIn(configs: readonly McpConfigDocument[]): Set<string> {
  const known = new Set<string>();
  for (const config of configs) {
    for (const [serverName, entry] of Object.entries(config.mcpServers)) {
      const logicalServers = entryBundles(entry) ?? [serverName];
      for (const logicalName of logicalServers) {
        for (const tool of MCP_TOOLS_BY_SERVER[logicalName] ?? []) known.add(tool);
      }
    }
  }
  return known;
}

interface CollectedMcpEntries {
  external: Record<string, McpServerEntry>;
  bundles: McpBundleName[];
  template: McpServerEntry | null;
}

function collectMcpEntries(documents: readonly McpConfigDocument[]): CollectedMcpEntries {
  const collected: CollectedMcpEntries = { external: {}, bundles: [], template: null };
  for (const document of documents) {
    for (const [name, entry] of Object.entries(document.mcpServers)) {
      const selected = entryBundles(entry);
      if (selected === null) {
        collected.external[name] = entry;
        continue;
      }
      collected.template ??= entry;
      collected.bundles.push(...selected);
    }
  }
  return collected;
}

function mergedMcpConfig(
  documents: readonly McpConfigDocument[], encodedAllowlist: string | undefined,
  selectedBundles?: readonly McpBundleName[],
): McpConfigDocument {
  const { external, bundles: declaredBundles, template } = collectMcpEntries(documents);
  const bundles = selectedBundles ?? declaredBundles;
  if (!template) return { mcpServers: external };
  if (external[BUNDLED_MCP_SERVER_NAME]) {
    throw new Error(`User MCP server name conflicts with reserved ${BUNDLED_MCP_SERVER_NAME}`);
  }
  const args = Array.isArray(template.args) ? [...template.args] : [];
  args[1] = encodeMcpBundles(bundles);
  const env = {
    ...(template.env ?? {}),
    ...(encodedAllowlist ? { [MCP_TOOL_ALLOWLIST_ENV]: encodedAllowlist } : {}),
  };
  return {
    mcpServers: {
      [BUNDLED_MCP_SERVER_NAME]: { ...template, args, env },
      ...external,
    },
  };
}

function materializedConfigPath(
  outputDir: string, configPaths: readonly string[], documents: readonly McpConfigDocument[],
  encodedAllowlist: string | undefined, selectedBundles: readonly McpBundleName[] | undefined,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ configPaths, documents, encodedAllowlist, selectedBundles }))
    .digest('hex').slice(0, 16);
  return path.join(outputDir, `mcp-composition-${digest}.json`);
}

export function materializeMcpToolAllowlistConfigs(
  configPaths: readonly string[], allowlist: readonly string[] | undefined,
  outputDir = path.join(CONFIG_DIR, 'mcp-tool-gates'),
  selectedBundles?: readonly McpBundleName[],
): string[] {
  if (allowlist === undefined) return [...configPaths];
  const documents = configPaths.map(readMcpConfig);
  const canonical = canonicalizeMcpToolAllowlist(allowlist);
  const selectedTools = selectedBundles
    ? new Set(selectedBundles.flatMap(bundle => MCP_TOOLS_BY_SERVER[bundle] ?? []))
    : knownToolsIn(documents);
  validateMcpToolAllowlist(canonical, selectedTools);
  const encoded = JSON.stringify(canonical);
  const materialized = mergedMcpConfig(documents, encoded, selectedBundles);
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  chmodSync(outputDir, 0o700);
  const target = materializedConfigPath(
    outputDir, configPaths, documents, encoded, selectedBundles,
  );
  writeFileSync(target, JSON.stringify(materialized, null, 2), { mode: 0o600 });
  chmodSync(target, 0o600);
  return [target];
}

/** Direct-session config: always-on tools plus direct-only Cortex management. */
export function buildFullConfig(serverRoot: string): object {
  return {
    mcpServers: {
      'cortex-core': bundledServerEntry([
        'cortex-core', 'cortex-tasks', 'cortex-manager-qa', 'cortex-ext',
      ], serverRoot),
    },
  };
}

/** Remote execution and time tools, isolated for restricted composition. */
export function buildCoreConfig(serverRoot: string): object {
  return {
    mcpServers: {
      'cortex-core': bundledServerEntry(['cortex-core'], serverRoot),
    },
  };
}

/** Read-only task monitoring for top-level direct and thread sessions. */
export function buildTasksConfig(serverRoot: string): object {
  return {
    mcpServers: {
      'cortex-tasks': bundledServerEntry(['cortex-tasks'], serverRoot),
    },
  };
}

/** Manager answer channel, loaded for top-level direct and thread sessions. */
export function buildManagerQaConfig(serverRoot: string): object {
  return {
    mcpServers: {
      'cortex-manager-qa': bundledServerEntry(['cortex-manager-qa'], serverRoot),
    },
  };
}

/** Complete built-in surface for thread/template sessions. */
export function buildThreadConfig(serverRoot: string): object {
  return {
    mcpServers: {
      'cortex-core': bundledServerEntry([
        'cortex-core', 'cortex-tasks', 'cortex-manager-qa', 'cortex-thread',
      ], serverRoot),
    },
  };
}

/** Strict empty composition with no declared MCP servers. */
export function buildEmptyConfig(): object {
  return { mcpServers: {} };
}

/** Claude interaction config; PI loads the same server through its MCP bridge. */
export function buildInteractionConfig(serverRoot: string): object {
  return {
    mcpServers: {
      'cortex-interaction-bridge': bundledServerEntry(['cortex-interaction-bridge'], serverRoot),
    },
  };
}

/** Explicit Slack-only composition; normal sessions select this bundle through process env. */
export function buildSlackConfig(serverRoot: string): object {
  return {
    mcpServers: {
      'cortex-slack': bundledServerEntry(['cortex-slack'], serverRoot),
    },
  };
}

/** Explicit Feishu-only composition; normal sessions select this bundle through process env. */
export function buildFeishuConfig(serverRoot: string): object {
  return {
    mcpServers: {
      'cortex-feishu': bundledServerEntry(['cortex-feishu'], serverRoot),
    },
  };
}

/** Explicit Web-only composition; normal sessions select this bundle through process env. */
export function buildWebConfig(serverRoot: string): object {
  return {
    mcpServers: {
      'cortex-web': bundledServerEntry(['cortex-web'], serverRoot),
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
    ['interaction', INTERACTION_MCP_CONFIG_PATH, buildInteractionConfig(SERVER_ROOT)],
    ['Slack', SLACK_MCP_CONFIG_PATH, buildSlackConfig(SERVER_ROOT)],
    ['Feishu', FEISHU_MCP_CONFIG_PATH, buildFeishuConfig(SERVER_ROOT)],
    ['Web', WEB_MCP_CONFIG_PATH, buildWebConfig(SERVER_ROOT)],
  ];
  for (const [label, configPath, config] of configs) {
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    log.info(`Generated ${label} MCP config at ${configPath}`);
  }
}
