// input:  startup environment and MCP config generator
// output: managed-asset sync decision and ensureMcpConfig
// pos:    Startup helpers for immutable config and MCP generation
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { createLogger } from '@core/log.js';
import { generateMcpConfig } from '@core/config-generator.js';

const log = createLogger('startup');

export function shouldSyncManagedStartupAssets(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.CORTEX_CONFIG_IMMUTABLE !== '1';
}

export function ensureMcpConfig(): void {
  try {
    generateMcpConfig();
    log.info('MCP config ensured');
  } catch (error) {
    log.warn(`Failed to ensure MCP config: ${(error as Error).message}`);
  }
}
