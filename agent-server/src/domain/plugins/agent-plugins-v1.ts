// input:  zod
// output: Agent Plugins v1 schema constants and validators
// pos:    Portable manifest and MCP schema mirror
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { z } from 'zod';

// Vendored from the official Agent Plugins 1.0.0 sources:
// - https://agent-plugins.org/schemas/1.0.0/plugin.schema.json
// - https://agent-plugins.org/schemas/1.0.0/mcp.schema.json
// - https://github.com/agentplugins/agent-plugins-spec/tree/main/schemas/1.0.0
// Blob SHAs at vendoring time: plugin 8fed0e1fe45d0464aee880d3fbab228b71ecfc1e,
// mcp a9139a4259b932c60b5351c8d9da6a5c60c97646.

export const AGENT_PLUGIN_V1_PLUGIN_SCHEMA_URL = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
export const AGENT_PLUGIN_V1_MCP_SCHEMA_URL = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

export const PORTABLE_MANIFEST_FIELDS = new Set([
  '$schema',
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'extensions',
]);

const nameRe = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const cwdRe = /^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/;
const reservedEnvNames = new Set(['PLUGIN_ROOT', 'PLUGIN_DATA']);

const manifestAuthorSchema = z.object({
  name: z.string().optional(),
  email: z.string().optional(),
  url: z.string().optional(),
}).strict();

const manifestExtensionsSchema = z.record(z.string(), z.record(z.string(), z.unknown()));

export const portableManifestSchema = z.object({
  $schema: z.literal(AGENT_PLUGIN_V1_PLUGIN_SCHEMA_URL),
  name: z.string().min(1).max(64).regex(nameRe),
  version: z.string().optional(),
  description: z.string().optional(),
  author: manifestAuthorSchema.optional(),
  homepage: z.string().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  extensions: manifestExtensionsSchema.optional(),
}).strict();

function checkReservedEnvKeys(env: Record<string, string>, ctx: z.RefinementCtx): void {
  for (const key of Object.keys(env)) {
    if (!reservedEnvNames.has(key)) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [key],
      message: `Reserved env key ${key} is not allowed`,
    });
  }
}

const stdioServerSchema = z.object({
  type: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).superRefine(checkReservedEnvKeys).optional(),
  cwd: z.string().regex(cwdRe).optional(),
}).strict();

const headersSchema = z.record(z.string(), z.string());

const streamableHttpServerSchema = z.object({
  type: z.literal('streamable-http'),
  url: z.string().min(1),
  headers: headersSchema.optional(),
}).strict();

const sseServerSchema = z.object({
  type: z.literal('sse'),
  url: z.string().min(1),
  headers: headersSchema.optional(),
}).strict();

export const portableMcpServerSchema = z.union([
  stdioServerSchema,
  streamableHttpServerSchema,
  sseServerSchema,
]);

export const portableMcpEnvelopeSchema = z.object({
  $schema: z.literal(AGENT_PLUGIN_V1_MCP_SCHEMA_URL),
  mcpServers: z.record(z.string(), z.unknown()),
}).strict();

export const portableMcpSchema = z.object({
  $schema: z.literal(AGENT_PLUGIN_V1_MCP_SCHEMA_URL),
  mcpServers: z.record(z.string(), portableMcpServerSchema),
}).strict();

export type PortableManifest = z.infer<typeof portableManifestSchema>;
export type PortableMcp = z.infer<typeof portableMcpSchema>;
export type PortableMcpEnvelope = z.infer<typeof portableMcpEnvelopeSchema>;
export type PortableMcpServer = z.infer<typeof portableMcpServerSchema>;
