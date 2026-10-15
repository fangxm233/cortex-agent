import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GENERIC_PROVIDER_ICON, ProviderIcon, providerBrand, resolveProviderIcon, scopeSvgIds } from './ProviderIcon';
import { PROVIDER_ICON_SVGS } from './provider-icon-data';

// The chat providers PI ships with (pi-ai providers/*.js); each must show its own brand glyph.
// The classifier-only `typesafe` provider has no brand glyph and takes the generic one.
const BUILT_IN_PI_PROVIDERS = [
  'amazon-bedrock', 'ant-ling', 'anthropic', 'azure', 'baseten', 'cerebras',
  'cloudflare-ai-gateway', 'cloudflare-workers-ai', 'deepseek', 'fireworks', 'github-copilot', 'google',
  'google-vertex', 'groq', 'huggingface', 'kimi-coding', 'meta', 'minimax', 'minimax-cn', 'mistral',
  'moonshotai', 'moonshotai-cn', 'nvidia', 'openai', 'openai-codex', 'opencode', 'opencode-go', 'openrouter',
  'qwen-token-plan', 'qwen-token-plan-cn', 'qwen-token-plan-individual', 'radius', 'together',
  'vercel-ai-gateway', 'xai', 'xiaomi', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-cn',
  'xiaomi-token-plan-sgp', 'zai', 'zai-coding-cn',
];

describe('ProviderIcon', () => {
  it('resolves every built-in PI provider to a brand glyph', () => {
    expect(BUILT_IN_PI_PROVIDERS).toHaveLength(41);
    for (const provider of BUILT_IN_PI_PROVIDERS) {
      const brand = providerBrand(provider);
      expect(brand, provider).not.toBe(GENERIC_PROVIDER_ICON);
      expect(PROVIDER_ICON_SVGS[brand], provider).toMatch(/^<svg/);
    }
  });

  it('falls back by id segment, then API family, then a generic glyph', () => {
    expect(providerBrand('qwen-local')).toBe('qwen');
    expect(providerBrand('my-vllm', 'openai-completions')).toBe('openai');
    expect(providerBrand('proxy', 'anthropic-messages')).toBe('anthropic');
    expect(providerBrand('my-vllm')).toBe(GENERIC_PROVIDER_ICON);
    expect(resolveProviderIcon('my-vllm')).toBe(PROVIDER_ICON_SVGS[GENERIC_PROVIDER_ICON]);
  });

  it('never renders a letter avatar', () => {
    const html = renderToStaticMarkup(<ProviderIcon provider="unknown-provider" label="Unknown" />);
    expect(html).toContain('<svg');
    expect(html).not.toMatch(/>U</);
  });

  it('scopes svg ids so two copies of a gradient glyph do not collide', () => {
    const svg = '<svg><defs><linearGradient id="g-0"></linearGradient></defs><path fill="url(#g-0)"></path><use href="#g-0"></use></svg>';
    expect(scopeSvgIds(svg, 'a-')).toBe('<svg><defs><linearGradient id="a-g-0"></linearGradient></defs><path fill="url(#a-g-0)"></path><use href="#a-g-0"></use></svg>');
    const html = renderToStaticMarkup(<>
      <ProviderIcon provider="google" label="Google" />
      <ProviderIcon provider="google" label="Google" />
    </>);
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
