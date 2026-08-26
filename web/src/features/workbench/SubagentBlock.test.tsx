// input:  subagent identity, complete prompt, and folded child content
// output: desktop prompt disclosure and count alignment tests
// pos:    Desktop subagent card presentation contract
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { LangProvider } from '@/i18n';
import { SubagentBlock } from './SubagentBlock';

describe('SubagentBlock', () => {
  it('reveals the complete multiline prompt when expanded', () => {
    const prompt = 'First line.\n\n' + 'A'.repeat(180) + '\nFinal line.';
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <LangProvider>
          <SubagentBlock
            agentType="explore"
            description="Inspect renderers"
            prompt={prompt}
            model="model-x"
            status="running"
            toolCount={1}
          >
            <div>child output</div>
          </SubagentBlock>
        </LangProvider>,
      );
    });

    expect(JSON.stringify(renderer.toJSON())).not.toContain(prompt);
    const count = renderer.root.findAll((node) => node.type === 'span' && node.children.join('') === '1 tool call')[0];
    expect(count.props.style.marginLeft).toBe('auto');
    act(() => renderer.root.findByProps({ role: 'button' }).props.onClick());
    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain(prompt.replace(/\n/g, '\\n'));
    expect(rendered).toContain('child output');
  });
});
