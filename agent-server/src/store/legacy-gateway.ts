// What the connections migration needs to read the gateway.yaml an earlier Cortex wrote: the file's
// layout, the section names it used, and the upstream URLs it generated for PI's built-in
// providers — so a route still on one of those is known to be Cortex's own, not a relay.

import { existsSync, readFileSync } from 'node:fs';
import { parse as yamlParse } from 'yaml';
import { createLogger } from '@core/log.js';

const log = createLogger('legacy-gateway');

/** endpoint (section) name → mode name → route object. */
export type EndpointMap = Record<string, Record<string, Record<string, unknown>>>;

/** The section Claude Code's routes shared with PI's built-in `anthropic` provider. */
export const ANTHROPIC_ENDPOINT = 'anthropic';
/** The mode PI's built-in `anthropic` provider owned in that shared section. */
export const PI_ANTHROPIC_MODE = 'pi-anthropic';

/** The mode a PI provider's generated route was written under. */
export function piGatewayMode(provider: string): string {
  return provider === ANTHROPIC_ENDPOINT ? PI_ANTHROPIC_MODE : provider;
}

/**
 * Every upstream URL Cortex generated for a PI built-in provider's route, current one first. The
 * later ones are where a provider lived before PI moved it (PI 1.3.0).
 */
export const GENERATED_PI_UPSTREAMS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ['https://api.anthropic.com'],
  fireworks: ['https://api.fireworks.ai/inference'],
  'github-copilot': ['https://api.individual.githubcopilot.com'],
  minimax: ['https://api.minimax.io/anthropic'],
  'minimax-cn': ['https://api.minimaxi.com/anthropic'],
  opencode: ['https://opencode.ai/inference', 'https://opencode.ai/zen'],
  'vercel-ai-gateway': ['https://ai-gateway.vercel.sh'],
  cerebras: ['https://api.cerebras.ai/v1'],
  deepseek: ['https://api.deepseek.com'],
  groq: ['https://api.groq.com/openai/v1'],
  huggingface: ['https://router.huggingface.co/v1'],
  'kimi-coding': ['https://api.kimi.com/coding/v1', 'https://api.kimi.com/coding'],
  mistral: ['https://api.mistral.ai'],
  openai: ['https://api.openai.com/v1'],
  'opencode-go': ['https://opencode.ai/inference/go/v1', 'https://opencode.ai/zen/go/v1'],
  openrouter: ['https://openrouter.ai/api/v1'],
  xai: ['https://api.x.ai/v1'],
  zai: ['https://api.z.ai/api/coding/paas/v4'],
  'openai-codex': ['https://chatgpt.com/backend-api'],
  'google-gemini-cli': ['https://cloudcode-pa.googleapis.com'],
  'google-antigravity': ['https://daily-cloudcode-pa.sandbox.googleapis.com'],
  google: ['https://generativelanguage.googleapis.com/v1beta'],
};

/** aistatus's reserved top-level keys: everything else is a section. */
const RESERVED_KEYS = new Set([
  'host', 'port', 'mode', 'auth', 'status_check', 'max_body_size_mb', 'endpoint_modes', 'endpoints',
]);
/** Keys that, directly on a section, make it a single-mode ("flat") route. */
const FLAT_ROUTE_KEYS = ['keys', 'base_url', 'auth_style', 'passthrough', 'fallbacks', 'model_fallbacks'];
/** The mode aistatus gives a flat section's one route. */
const FLAT_MODE = 'default';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sectionModes(section: Record<string, unknown>): Record<string, Record<string, unknown>> {
  if (FLAT_ROUTE_KEYS.some((key) => key in section)) return { [FLAT_MODE]: section };
  return Object.fromEntries(Object.entries(section).filter(([, route]) => isPlainObject(route))) as
    Record<string, Record<string, unknown>>;
}

function parseYaml(filePath: string): unknown {
  try {
    return yamlParse(readFileSync(filePath, 'utf-8'));
  } catch (error) {
    log.warn(`Ignoring unparseable gateway.yaml (${filePath}): ${(error as Error).message}`);
    return null;
  }
}

/** The route tree of a gateway.yaml; null when the file is absent or unparseable. */
export function readGatewayEndpoints(filePath: string): EndpointMap | null {
  if (!existsSync(filePath)) return null;
  const raw = parseYaml(filePath);
  if (!isPlainObject(raw)) return null;
  const endpoints: EndpointMap = {};
  for (const [name, section] of Object.entries(raw)) {
    if (RESERVED_KEYS.has(name) || !isPlainObject(section)) continue;
    const modes = sectionModes(section);
    if (Object.keys(modes).length > 0) endpoints[name] = modes;
  }
  return endpoints;
}
