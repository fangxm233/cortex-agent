import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { LangProvider } from '@/i18n';
import { ChatMarkdown } from '@/design/ChatMarkdown';
import { MChatStream } from '@/mobile/screens/MChatView';
import { ChatRows } from './MessageStream';
import { ThinkingRow } from './HintRow';
import { ToolCallsRow } from './ToolCallsRow';
import type { ChatRow } from './chat-row';

vi.mock('@/lib/trpc', () => ({ useTRPCClient: () => ({}) }));
let mounted: ReactTestRenderer;
afterEach(() => act(() => mounted?.unmount()));
const thought = { kind: 'thinking' as const, text: 'First line\n**Full thought**' };
const hint = () => mounted.root.find((node) => node.type === 'div' && node.props['data-thinking'] === true);
const body = () => mounted.root.findAll((node) => node.type === 'div' && node.props['data-thinking-body'] === true);

function mountRows(rows: ChatRow[], mobile: boolean): void {
  act(() => { mounted = create(<LangProvider>{mobile ? <MChatStream rows={rows} /> : <ChatRows rows={rows} />}</LangProvider>); });
}

describe('thinking display', () => {
  it.each([false, true])('renders a collapsed, keyboard-expandable muted row (mobile=%s)', (mobile) => {
    mountRows([thought], mobile);
    expect(hint().props['aria-expanded']).toBe(false);
    expect(body()).toHaveLength(0);
    const summary = hint().find((node) => node.type === 'span' && node.children.includes('First line'));
    expect(summary.props.style).toMatchObject({ whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' });
    act(() => hint().props.onKeyDown({ key: 'Enter', preventDefault: vi.fn() }));
    expect(body()).toHaveLength(1);
    expect(body()[0].props.style.color).toBe('var(--proto-muted)');
    expect(body()[0].findByType(ChatMarkdown).props.text).toBe(thought.text);
    expect(mounted.root.findAll((node) => node.props['data-assistant-turn-copy'] === 'true')).toHaveLength(0);
  });

  it.each([false, true])('shows only the latest preview line (mobile=%s)', (mobile) => {
    mountRows([{ ...thought, preview: true }], mobile);
    expect(hint().props['aria-expanded']).toBeUndefined();
    const text = JSON.stringify(hint().children.map((child) => typeof child === 'string' ? child : child.props));
    expect(text).toContain('Thinking…');
    expect(text).toContain('**Full thought**');
    expect(text).not.toContain('First line');
    expect(body()).toHaveLength(0);
  });

  it.each([false, true])('keeps the thinking chip and independently expandable body in tool order (mobile=%s)', (mobile) => {
    mountRows([{ kind: 'tools', count: 2, calls: [
      { kind: 'read', input: 'a.ts' }, { kind: 'thinking', thinking: true, input: thought.text },
      { kind: 'bash', input: 'pwd' },
    ] }], mobile);
    const toolRow = mounted.root.findByType(ToolCallsRow);
    expect(toolRow.props.calls[1].thinking).toBe(true);
    const toggle = toolRow.findByType('button');
    expect(toggle.findAll((node) => node.type === 'span' && node.children.some((child) => typeof child === 'string' && child.includes('Thought once'))).length).toBeGreaterThan(0);
    act(() => toggle.props.onClick());
    const panel = toolRow.findByProps({ 'data-tool-calls-panel': true });
    expect(panel.children.map((child) => typeof child === 'string' ? child : child.props.call.kind))
      .toEqual(['read', 'thinking', 'bash']);
    expect(hint().props['aria-expanded']).toBe(false);
    act(() => hint().props.onClick());
    expect(body()[0].findByType(ChatMarkdown).props.text).toBe(thought.text);
    expect(toggle.props['aria-expanded']).toBe(true);
    const stopPropagation = vi.fn();
    const guard = mounted.root.findByType(ThinkingRow).parent!;
    act(() => guard.props.onClick({ stopPropagation }));
    expect(stopPropagation).toHaveBeenCalledOnce();
  });
});
