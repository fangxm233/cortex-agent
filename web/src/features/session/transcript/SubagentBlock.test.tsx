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
    const header = renderer.root.findByProps({ role: 'button' });
    expect(header.type).toBe('button');
    expect(header.props.className).toContain('focus-visible:outline');
    expect(header.props.style.position).toBe('sticky');
    expect(header.props.style.top).toBe('var(--transcript-sticky-top, 0px)');
    // Collapsed it is one more quiet line; open, the pinned header occludes its own body.
    expect(header.props.style.background).toBe('transparent');
    expect(header.props.style.backdropFilter).toBeUndefined();
    act(() => header.props.onClick());
    expect(renderer.root.findByProps({ role: 'button' }).props.style.background).toBe('var(--proto-card)');
    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain(prompt.replace(/\n/g, '\\n'));
    expect(rendered).toContain('child output');
  });

  it('names a clean subagent in its meta line', () => {
    let renderer!: ReactTestRenderer;
    const mount = (clean: boolean) => (
      <LangProvider>
        <SubagentBlock agentType="explore" description="Inspect" prompt={null} model={null} status="done" toolCount={2} clean={clean}>
          <div />
        </SubagentBlock>
      </LangProvider>
    );
    act(() => { renderer = create(mount(true)); });
    const meta = () => renderer.root.find((node) => node.props.style?.marginLeft === 'auto').props.children;
    expect(meta()).toBe('clean · 2 tool calls');
    act(() => renderer.update(mount(false)));
    expect(meta()).toBe('2 tool calls');
  });

  it('touch headers wrap at a finger-sized height without hover state', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <LangProvider>
          <SubagentBlock agentType="explore" description="Inspect renderers" prompt={null} model={null} status="done" toolCount={2} touch>
            <div>child output</div>
          </SubagentBlock>
        </LangProvider>,
      );
    });
    const header = renderer.root.findByProps({ role: 'button' });
    expect(header.props.style).toMatchObject({ minHeight: 44, flexWrap: 'wrap', background: 'transparent', top: 'var(--transcript-sticky-top, 0px)' });
    expect(header.props.onMouseEnter).toBeUndefined();
    act(() => header.props.onClick());
    expect(JSON.stringify(renderer.toJSON())).toContain('child output');
  });

  it('keeps a touch meta line inside the card and covers the body above a pinned header', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <LangProvider>
          <SubagentBlock agentType="general-purpose" description="Prototype bundled server" prompt={null} model={null}
            status="running" toolCount={98} background touch>
            <div>child output</div>
          </SubagentBlock>
        </LangProvider>,
      );
    });
    const meta = renderer.root.find((node) => node.type === 'span' && node.props.children === 'running in the background · 98 tool calls');
    expect(meta.props.style).toMatchObject({ flex: '1 1 100%', boxSizing: 'border-box', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' });
    const cover = () => renderer.root.findAll((node) => node.type === 'span' && node.props['aria-hidden'] === true);
    expect(cover()).toHaveLength(0);
    act(() => renderer.root.findByProps({ role: 'button' }).props.onClick());
    expect(renderer.root.findByProps({ 'data-subagent-block': '' }).props.style.overflow).toBe('clip');
    expect(cover()).toHaveLength(1);
    expect(cover()[0].props.style).toMatchObject({ position: 'absolute', zIndex: -1, background: 'var(--proto-card)' });
    expect(cover()[0].props.style.height).toContain('var(--transcript-sticky-top, 0px)');
  });

  it('leaves the desktop card unclipped', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <LangProvider>
          <SubagentBlock agentType="explore" description="Inspect" prompt={null} model={null} status="done" toolCount={2}>
            <div />
          </SubagentBlock>
        </LangProvider>,
      );
    });
    act(() => renderer.root.findByProps({ role: 'button' }).props.onClick());
    expect(renderer.root.findByProps({ 'data-subagent-block': '' }).props.style.overflow).toBeUndefined();
    expect(renderer.root.findAll((node) => node.type === 'span' && node.props['aria-hidden'] === true)).toHaveLength(0);
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
