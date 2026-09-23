// input:  ToolCallsRow, React test renderer, mocked debug API
// output: Tool layout, collapse and lazy inspection regression tests
// pos:    Tool group spacing, focus and click behavior coverage
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';
import type { ToolCall } from './chat-content';
import { DebugDetailsModal, DebugInspectButton } from './DebugDetailsModal';
import { ToolCallsRow } from './ToolCallsRow';

const harness = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/trpc', () => ({
  useTRPCClient: () => ({ sessions: { debugDetails: { query: harness.query } } }),
}));
vi.mock('./DebugDetailsModal', () => ({
  DebugDetailsModal: () => null,
  DebugInspectButton: () => null,
}));

const calls: ToolCall[] = [
  { kind: 'read', label: 'read file.ts', input: 'file.ts', debug: { toolRef: 'tool-1' } },
  { kind: 'bash', label: 'bash pwd', input: 'pwd' },
];
function mount(items = calls, touch = false): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(<LangProvider><ToolCallsRow calls={items} sessionId="s1" touch={touch} /></LangProvider>); });
  return renderer;
}

beforeEach(() => { harness.query.mockReset(); });

describe('ToolCallsRow', () => {
  it('keeps the same mounted toggle and chip measurement across expansion and collapse', () => {
    const renderer = mount();
    const toggle = renderer.root.findByType('button');
    const measure = toggle.findByProps({ 'aria-hidden': 'true' });
    expect(toggle.props['aria-expanded']).toBe(false);
    expect(toggle.props.className).toContain('focus-visible:outline');
    act(() => toggle.props.onClick());
    expect(renderer.root.findByType('button') === toggle).toBe(true);
    expect(toggle.props['aria-expanded']).toBe(true);
    expect(toggle.findByProps({ 'aria-hidden': 'true' }) === measure).toBe(true);
    expect(renderer.root.findAllByType(DebugInspectButton)).toHaveLength(1);
    act(() => toggle.props.onClick());
    expect(renderer.root.findByType('button') === toggle).toBe(true);
    expect(toggle.props['aria-expanded']).toBe(false);
    expect(toggle.findByProps({ 'aria-hidden': 'true' }) === measure).toBe(true);
    expect(renderer.root.findAllByType(DebugInspectButton)).toHaveLength(0);
    expect(harness.query).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('keeps the summary and clickable details in one spaced group', () => {
    const renderer = mount();
    const toggle = renderer.root.findByType('button');
    act(() => toggle.props.onClick());
    const group = renderer.root.findByProps({ 'data-tool-calls': true });
    const panel = renderer.root.findByProps({ 'data-tool-calls-panel': true });
    expect(group.props.style).toMatchObject({ display: 'flex', flexDirection: 'column', gap: 6 });
    expect(panel.props.style.marginTop ?? 0).toBeGreaterThanOrEqual(0);
    expect(toggle.parent!.props.style?.margin ?? 0).toBe(0);
    act(() => panel.props.onClick());
    expect(toggle.props['aria-expanded']).toBe(false);
    expect(renderer.root.findAllByProps({ 'data-tool-calls-panel': true })).toHaveLength(0);
    expect(renderer.root.findByType('button')).toBe(toggle);
    act(() => renderer.unmount());
  });

  it('loads missing debug details only on inspect, not on expansion', async () => {
    const loaded = { toolInput: { path: 'file.ts' }, toolResult: { content: 'source', isError: false } };
    harness.query.mockResolvedValue(loaded);
    const renderer = mount();
    expect(harness.query).not.toHaveBeenCalled();
    act(() => renderer.root.findByType('button').props.onClick());
    expect(harness.query).not.toHaveBeenCalled();
    const stopPropagation = vi.fn();
    await act(async () => {
      renderer.root.findByType(DebugInspectButton).props.onClick({ stopPropagation });
    });
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(renderer.root.findByType('button').props['aria-expanded']).toBe(true);
    expect(harness.query).toHaveBeenCalledTimes(1);
    expect(harness.query).toHaveBeenCalledWith({ sessionId: 's1', ref: 'tool-1' });
    expect(renderer.root.findByType(DebugDetailsModal).props.detail).toMatchObject(loaded);
    act(() => renderer.unmount());
  });

  it('does not fetch a tool result already present in the transcript', () => {
    const toolResult = { content: 'cached', isError: false };
    const renderer = mount([{ ...calls[0], debug: { toolRef: 'tool-1', toolResult } }]);
    act(() => renderer.root.findByType('button').props.onClick());
    act(() => renderer.root.findByType(DebugInspectButton).props.onClick({ stopPropagation: vi.fn() }));
    expect(harness.query).not.toHaveBeenCalled();
    expect(renderer.root.findByType(DebugDetailsModal).props.detail.toolResult).toEqual(toolResult);
    act(() => renderer.unmount());
  });

  it('touch rows keep the same chrome with a finger-sized target and visible inspection', () => {
    const renderer = mount(calls, true);
    const toggle = renderer.root.findByType('button');
    expect(toggle.props.style.minHeight).toBe(44);
    expect(toggle.props.onMouseEnter).toBeUndefined();
    expect(renderer.root.findByProps({ 'data-tool-calls': true }).props.style.margin).toBe('-14px 0');
    act(() => toggle.props.onClick());
    expect(renderer.root.findByProps({ 'data-tool-calls': true }).props.style.margin).toBe('-14px 0 0');
    expect(renderer.root.findByType(DebugInspectButton).props.visible).toBe(true);
    act(() => renderer.unmount());
  });
});
