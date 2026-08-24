// input:  MCP and interaction duration contracts
// output: Shared infrastructure timeout constant
// pos:    Defines the outer deadline for MCP and loopback requests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

export const MCP_INFRASTRUCTURE_TIMEOUT_MS = 30 * 60 * 1000 + 30 * 1000;
