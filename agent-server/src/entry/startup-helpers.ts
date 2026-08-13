// input:  MCP config generator
// output: ensureMcpConfig
// pos:    Startup helper for MCP config generation
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { createLogger } from '@core/log.js';
import { generateMcpConfig } from '@core/config-generator.js';

const log = createLogger('startup');

export function ensureMcpConfig(): void {
  try {
    generateMcpConfig();
    log.info('MCP config ensured');
  } catch (error) {
    log.warn(`Failed to ensure MCP config: ${(error as Error).message}`);
  }
}
