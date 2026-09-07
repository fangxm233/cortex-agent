// input:  subagent identity, folded rows, and turn-copy actions
// output: rounded sticky header, prompt, count, and copy tests
// pos:    Desktop subagent card presentation contract
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';
import type { ChatRow } from './transcript-vm';
import { ChatRows } from './MessageStream';
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
    const header = renderer.root.findByProps({ role: 'button' });
    expect(header.props.style).toMatchObject({
      position: 'sticky', top: 0, zIndex: 1, background: 'var(--proto-rail)',
      borderRadius: 7,
    });
    expect(header.parent!.props.style.overflow).toBeUndefined();
    act(() => header.props.onClick());
    expect(header.props.style.borderRadius).toBe('7px 7px 0 0');
    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain(prompt.replace(/\n/g, '\\n'));
    expect(rendered).toContain('child output');
    act(() => header.props.onClick());
    expect(header.props.style.borderRadius).toBe(7);
  });

  it('keeps one outer turn-copy action after an expanded subagent', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const rows: ChatRow[] = [
      { kind: 'user', text: 'question' },
      { kind: 'assistant', text: 'main answer', streaming: false },
      {
        kind: 'subagent', id: 'tu_a', agentType: 'explore', description: 'Inspect renderers',
        prompt: 'inspect everything', model: 'model-x', status: 'done', toolCount: 1,
        children: [{ kind: 'assistant', text: 'child output', streaming: false }],
      },
    ];
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<LangProvider><ChatRows rows={rows} /></LangProvider>);
    });

    expect(renderer.root.findAllByProps({ 'data-assistant-turn-copy': 'true' })).toHaveLength(1);
    act(() => renderer.root.findByProps({ 'aria-expanded': false }).props.onClick());
    const actions = renderer.root.findAllByProps({ 'data-assistant-turn-copy': 'true' });
    expect(actions).toHaveLength(1);
    act(() => actions[0].findByProps({ title: 'Copy' }).props.onClick());
    expect(writeText).toHaveBeenCalledWith('main answer');
    vi.unstubAllGlobals();
  });
});
