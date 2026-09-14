// input:  nothing — a static table of Anthropic model ids
// output: the default Anthropic tier ids, including [1m] context-window variants
// pos:    Anthropic model table, split out of gateway-generator so the MCP sidecar can import it
//         without dragging in gateway-generator's yaml/dotenv/pi-sdk dependencies

// Each 1M-capable model also exposes a "[1m]" variant — Claude Code's context-window suffix that
// opts the session into the 1M-token window. Haiku 4.5 is 200K-only, so it has no [1m] variant.
export const ANTHROPIC_MODELS: readonly string[] = [
  'claude-fable-5-1', 'claude-fable-5-1[1m]',
  'claude-fable-5', 'claude-fable-5[1m]',
  'claude-opus-5', 'claude-opus-5[1m]',
  'claude-opus-4-8', 'claude-opus-4-8[1m]',
  'claude-opus-4-7', 'claude-opus-4-7[1m]',
  'claude-opus-4-6', 'claude-opus-4-6[1m]',
  'claude-sonnet-5', 'claude-sonnet-5[1m]',
  'claude-sonnet-4-6', 'claude-sonnet-4-6[1m]',
  'claude-haiku-4-5',
];
