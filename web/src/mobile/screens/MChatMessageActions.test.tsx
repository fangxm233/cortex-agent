import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatRow } from '@/features/session/transcript/transcript-vm';
import { MsgActionMenu } from './MChatMessageActions';
import { MSG_MENU_SAFE_TOP } from './m-chat-vm';

// The 7a overlay floats a copy of the held bubble where the finger is, pushed down only to clear the
// floating header stack (the placement maths itself is m-chat-vm `msgMenuGroupTop`). That stack is
// the header pill plus, on a lead, the team row under it; its bottom edge is the one the chat screen
// publishes as --chat-header-bottom, so a bubble held right under the header must not float over
// the team row.

const row: ChatRow = { kind: 'user', text: 'held message' };

function mount(headerBottom: string): ReactTestRenderer {
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: (name: string) => (name === '--chat-header-bottom' ? headerBottom : ''),
  }));
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <MsgActionMenu row={row} menu={{ rowIndex: 0, anchorTop: 70, onCopy: vi.fn(), onClose: vi.fn() }} />,
      {
        createNodeMock: (node) => (node.props['data-msg-menu-group']
          ? { getBoundingClientRect: () => ({ top: 0, height: 200 }) }
          : { getBoundingClientRect: () => ({ top: 0, height: 800 }) }),
      },
    );
  });
  return renderer;
}

const groupStyle = (r: ReactTestRenderer) => r.root.findByProps({ 'data-msg-menu-group': 'true' }).props.style;

afterEach(() => { vi.unstubAllGlobals(); });

describe('MsgActionMenu placement', () => {
  it('keeps the floated bubble clear of the whole header stack, team row included', () => {
    const r = mount('106px');
    expect(groupStyle(r).top).toBe(114);
    expect(groupStyle(r).maxHeight).toBe('calc(100% - 130px)');
    act(() => r.unmount());
  });

  it('stays on the held bubble when the stack ends above it', () => {
    const r = mount('60px');
    expect(groupStyle(r).top).toBe(70);
    act(() => r.unmount());
  });

  it('falls back to the bare inset where no header clearance is published', () => {
    const r = mount('');
    expect(groupStyle(r).top).toBe(70);
    expect(groupStyle(r).maxHeight).toBe(`calc(100% - ${MSG_MENU_SAFE_TOP + 16}px)`);
    act(() => r.unmount());
  });
});
