// input:  MCP bundle names and encoded process environment
// output: Validated Cortex MCP bundle selections
// pos:    Shared contract for per-process MCP composition
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

export const MCP_BUNDLES_ENV = 'CORTEX_MCP_BUNDLES';
export const BUNDLED_MCP_SERVER_NAME = 'cortex-core';

export const MCP_BUNDLE_NAMES = [
  'cortex-core',
  'cortex-tasks',
  'cortex-manager-qa',
  'cortex-thread',
  'cortex-ext',
  'cortex-interaction-bridge',
  'cortex-slack',
  'cortex-feishu',
  'cortex-web',
] as const;

export type McpBundleName = typeof MCP_BUNDLE_NAMES[number];

const MCP_BUNDLE_SET = new Set<string>(MCP_BUNDLE_NAMES);
const MCP_BUNDLE_ORDER = new Map(MCP_BUNDLE_NAMES.map((name, index) => [name, index]));

export function isMcpBundleName(value: string): value is McpBundleName {
  return MCP_BUNDLE_SET.has(value);
}

export function canonicalizeMcpBundles(values: readonly McpBundleName[]): McpBundleName[] {
  return [...new Set(values)].sort((left, right) => {
    return MCP_BUNDLE_ORDER.get(left)! - MCP_BUNDLE_ORDER.get(right)!;
  });
}

export function encodeMcpBundles(values: readonly McpBundleName[]): string {
  return JSON.stringify(canonicalizeMcpBundles(values));
}

export function parseMcpBundles(raw: string | undefined): McpBundleName[] {
  if (raw === undefined) throw new Error(`${MCP_BUNDLES_ENV} is required`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${MCP_BUNDLES_ENV} must be a JSON string array`);
  }
  if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string')) {
    throw new Error(`${MCP_BUNDLES_ENV} must be a JSON string array`);
  }
  const unknown = parsed.filter(value => !isMcpBundleName(value));
  if (unknown.length > 0) throw new Error(`Unknown Cortex MCP bundle(s): ${unknown.join(', ')}`);
  return canonicalizeMcpBundles(parsed as McpBundleName[]);
}
