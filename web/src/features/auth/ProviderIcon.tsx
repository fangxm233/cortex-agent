import { useId, useMemo } from 'react';
import { PROVIDER_ICON_SVGS } from './provider-icon-data';

// Provider id → brand glyph. Every built-in PI provider is listed; other ids (custom providers,
// regional variants) retry with their first hyphen segment, then with their API family, and end
// on a generic server glyph — never a letter.
const BRAND_BY_PROVIDER: Record<string, string> = {
  'amazon-bedrock': 'bedrock',
  'ant-ling': 'antgroup',
  anthropic: 'anthropic',
  azure: 'azure',
  'azure-openai-responses': 'azure',
  baseten: 'baseten',
  bedrock: 'bedrock',
  cerebras: 'cerebras',
  claude: 'claude',
  'claude-code': 'claude',
  cloudflare: 'cloudflare',
  'cloudflare-ai-gateway': 'cloudflare',
  'cloudflare-workers-ai': 'cloudflare',
  deepseek: 'deepseek',
  fireworks: 'fireworks',
  gemini: 'gemini',
  'github-copilot': 'githubcopilot',
  google: 'gemini',
  'google-vertex': 'vertexai',
  groq: 'groq',
  huggingface: 'huggingface',
  kimi: 'kimi',
  'kimi-coding': 'kimi',
  meta: 'meta',
  minimax: 'minimax',
  'minimax-cn': 'minimax',
  mistral: 'mistral',
  moonshotai: 'moonshot',
  'moonshotai-cn': 'moonshot',
  nvidia: 'nvidia',
  openai: 'openai',
  'openai-codex': 'codex',
  opencode: 'opencode',
  'opencode-go': 'opencode',
  openrouter: 'openrouter',
  qwen: 'qwen',
  'qwen-token-plan': 'qwen',
  'qwen-token-plan-cn': 'qwen',
  'qwen-token-plan-individual': 'qwen',
  radius: 'pi',
  together: 'together',
  vercel: 'vercel',
  'vercel-ai-gateway': 'vercel',
  xai: 'xai',
  xiaomi: 'xiaomimimo',
  'xiaomi-token-plan-ams': 'xiaomimimo',
  'xiaomi-token-plan-cn': 'xiaomimimo',
  'xiaomi-token-plan-sgp': 'xiaomimimo',
  zai: 'zai',
  'zai-coding-cn': 'zai',
};

export const GENERIC_PROVIDER_ICON = 'server';

function firstSegment(value: string): string {
  return value.split('-', 1)[0] ?? '';
}

/** Brand key for a provider id, optionally its API family (`openai-completions`, `anthropic-messages`). */
export function providerBrand(provider: string, api?: string): string {
  return BRAND_BY_PROVIDER[provider]
    ?? BRAND_BY_PROVIDER[firstSegment(provider)]
    ?? (api ? BRAND_BY_PROVIDER[api] ?? BRAND_BY_PROVIDER[firstSegment(api)] : undefined)
    ?? GENERIC_PROVIDER_ICON;
}

export function resolveProviderIcon(provider: string, api?: string): string {
  return PROVIDER_ICON_SVGS[providerBrand(provider, api)] ?? PROVIDER_ICON_SVGS[GENERIC_PROVIDER_ICON]!;
}

/** Gradient and clip ids are document-global; prefix them so two copies of one glyph never clash. */
export function scopeSvgIds(svg: string, prefix: string): string {
  return svg
    .replace(/\bid="([^"]+)"/g, (_m, id: string) => `id="${prefix}${id}"`)
    .replace(/url\(#([^)]+)\)/g, (_m, id: string) => `url(#${prefix}${id})`)
    .replace(/href="#([^"]+)"/g, (_m, id: string) => `href="#${prefix}${id}"`);
}

export interface ProviderIconProps {
  provider: string;
  /** Accessible name is carried by the adjacent text; kept for call sites that pass it. */
  label?: string;
  /** API family of a custom provider, used when the id names no known brand. */
  api?: string;
  size?: number;
}

export function ProviderIcon({ provider, api, size = 16 }: ProviderIconProps) {
  const prefix = `pi${useId().replace(/[^a-zA-Z0-9_-]/g, '')}-`;
  const svg = useMemo(() => scopeSvgIds(resolveProviderIcon(provider, api), prefix), [provider, api, prefix]);
  return (
    <span
      aria-hidden data-provider-icon={provider} data-provider-brand={providerBrand(provider, api)}
      style={{ fontSize: size, lineHeight: 0, display: 'inline-flex', flex: 'none' }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
