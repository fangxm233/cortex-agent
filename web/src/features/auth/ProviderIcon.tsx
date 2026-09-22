import { PROVIDER_ICON_SVGS } from './provider-icon-data';

// Exact provider-id → brand glyph. Unknown ids retry with their first hyphen
// segment (e.g. a custom "qwen-*" deployment), then fall back to a letter.
const BRAND_BY_PROVIDER: Record<string, string> = {
  'amazon-bedrock': 'bedrock',
  'ant-ling': 'antgroup',
  anthropic: 'anthropic',
  azure: 'azure',
  'azure-openai-responses': 'azure',
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
  together: 'together',
  'vercel-ai-gateway': 'vercel',
  xai: 'xai',
  xiaomi: 'xiaomimimo',
  'xiaomi-token-plan-ams': 'xiaomimimo',
  'xiaomi-token-plan-cn': 'xiaomimimo',
  'xiaomi-token-plan-sgp': 'xiaomimimo',
  zai: 'zai',
  'zai-coding-cn': 'zai',
};

export function resolveProviderIcon(provider: string): string | null {
  const brand = BRAND_BY_PROVIDER[provider] ?? BRAND_BY_PROVIDER[provider.split('-', 1)[0] ?? ''];
  return brand ? PROVIDER_ICON_SVGS[brand] ?? null : null;
}

export interface ProviderIconProps {
  provider: string;
  label: string;
  size?: number;
}

export function ProviderIcon({ provider, label, size = 16 }: ProviderIconProps) {
  const svg = resolveProviderIcon(provider);
  if (svg) {
    return (
      <span
        aria-hidden data-provider-icon={provider}
        style={{ fontSize: size, lineHeight: 0, display: 'inline-flex', flex: 'none' }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }
  return (
    <span
      aria-hidden data-provider-icon={provider}
      style={{
        width: size, height: size, borderRadius: '50%', flex: 'none', boxSizing: 'border-box',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        // Ringed rather than bordered: the letter avatar sits inline next to brand glyphs that have
        // no outline at all, so its edge must not take a pixel of the glyph's box.
        background: 'var(--glass-2)', boxShadow: '0 0 0 1px var(--proto-line-2)',
        fontSize: Math.round(size * 0.55), fontWeight: 700, color: 'var(--proto-muted-2)',
        lineHeight: 1,
      }}
    >
      {(label.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}
