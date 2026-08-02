// input:  ProviderIcon component and resolver
// output: brand icon resolution and letter fallback tests
// pos:    Pins provider icon mapping behavior
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { ProviderIcon, resolveProviderIcon } from './ProviderIcon';

function mount(provider: string, label: string): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(<ProviderIcon provider={provider} label={label} />); });
  return renderer;
}

describe('ProviderIcon', () => {
  it('resolves brand markup for exact ids, id prefixes, and the Claude card', () => {
    const known = ['deepseek', 'openai-codex', 'cloudflare-workers-ai', 'amazon-bedrock', 'qwen-ksu', 'claude-code'];
    for (const provider of known) {
      expect(resolveProviderIcon(provider), provider).toMatch(/^<svg /);
    }
    expect(resolveProviderIcon('radius')).toBeNull();
  });

  it('renders inline svg markup for a known provider', () => {
    const icon = mount('deepseek', 'DeepSeek').root.findByProps({ 'data-provider-icon': 'deepseek' });
    expect(icon.props.dangerouslySetInnerHTML.__html).toContain('<svg ');
  });

  it('falls back to a letter avatar for unknown providers', () => {
    const renderer = mount('radius', 'radius');
    const icon = renderer.root.findByProps({ 'data-provider-icon': 'radius' });
    expect(icon.props.dangerouslySetInnerHTML).toBeUndefined();
    expect(JSON.stringify(renderer.toJSON())).toContain('"R"');
  });
});
