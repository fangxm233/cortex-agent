// input:  ToolCallsRow, React test renderer, mocked debug API
// output: Stable toggle and lazy tool inspection regression tests
// pos:    Tool expansion identity and debug loading coverage
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
function mount(items = calls): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(<LangProvider><ToolCallsRow calls={items} sessionId="s1" /></LangProvider>); });
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

  it('loads missing debug details only on inspect, not on expansion', async () => {
    const loaded = { toolInput: { path: 'file.ts' }, toolResult: { content: 'source', isError: false } };
    harness.query.mockResolvedValue(loaded);
    const renderer = mount();
    expect(harness.query).not.toHaveBeenCalled();
    act(() => renderer.root.findByType('button').props.onClick());
    expect(harness.query).not.toHaveBeenCalled();
    await act(async () => {
      renderer.root.findByType(DebugInspectButton).props.onClick({ stopPropagation: vi.fn() });
    });
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
});
