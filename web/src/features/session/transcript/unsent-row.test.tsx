import { describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { SessionTranscript } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';
import { MChatStream } from '@/mobile/screens/MChatView';
import { ChatRows } from './MessageStream';
import { buildTranscriptRows, markPendingUnsent, withdrawPending, type ChatRow, type PendingUserMessage } from './transcript-vm';
import { UnsentActionsContext, type UnsentActions } from './useUnsentActions';

const T = '2026-10-31T16:29:47.000Z';
const transcript: SessionTranscript = { sessionId: 's1', turns: [] };
const pending: PendingUserMessage[] = [
  { id: 'pin-1', ts: T, text: 'merge it into xteleop' },
  { id: 'pin-2', ts: T, text: 'tell me the wiring' },
];

describe('pending rows whose run was stopped', () => {
  it('marks only the named row unsent and leaves the list alone for an unknown id', () => {
    const next = markPendingUnsent(pending, 'pin-2');
    expect(next.map((p) => !!p.unsent)).toEqual([false, true]);
    expect(markPendingUnsent(pending, 'pin-9')).toBe(pending);
    expect(markPendingUnsent(next, 'pin-2')).toBe(next);
  });

  it('drops a withdrawn row', () => {
    expect(withdrawPending(pending, 'pin-1').map((p) => p.id)).toEqual(['pin-2']);
    expect(withdrawPending(pending, 'pin-9')).toBe(pending);
  });

  it('carries the unsent state and its id onto the pinned row', () => {
    const rows = buildTranscriptRows(transcript, [], { pendingUser: markPendingUnsent(pending, 'pin-2') });
    const users = rows.filter((row): row is Extract<ChatRow, { kind: 'user' }> => row.kind === 'user');
    expect(users.map((row) => [row.pending, row.unsent, row.pendingId])).toEqual([
      [true, undefined, undefined],
      [true, true, 'pin-2'],
    ]);
  });
});

const unsentRow: ChatRow = { kind: 'user', text: 'tell me the wiring', ts: T, pending: true, unsent: true, pendingId: 'pin-2' };

function render(node: JSX.Element, actions: UnsentActions | null): ReactTestRenderer {
  let r!: ReactTestRenderer;
  act(() => {
    r = create(<LangProvider><UnsentActionsContext.Provider value={actions}>{node}</UnsentActionsContext.Provider></LangProvider>);
  });
  return r;
}

function buttons(r: ReactTestRenderer) {
  const line = r.root.find((n) => n.type === 'div' && n.props['data-unsent'] !== undefined);
  return line.findAll((n) => n.type === 'button');
}

describe('the unsent row offers send and edit', () => {
  it.each([
    ['desktop', <ChatRows rows={[unsentRow]} />],
    ['mobile', <MChatStream rows={[unsentRow]} />],
  ])('%s: each button resolves the row with its action', (_surface, node) => {
    const resolve = vi.fn();
    const r = render(node, { resolve, busy: false });
    const [send, edit] = buttons(r);
    act(() => send.props.onClick());
    act(() => edit.props.onClick());
    expect(resolve.mock.calls).toEqual([['pin-2', 'send'], ['pin-2', 'edit']]);
    act(() => r.unmount());
  });

  it('shows the state without actions where the chat offers none, and none while one is in flight', () => {
    const readOnly = render(<ChatRows rows={[unsentRow]} />, null);
    expect(buttons(readOnly)).toHaveLength(0);
    act(() => readOnly.unmount());
    const busy = render(<ChatRows rows={[unsentRow]} />, { resolve: vi.fn(), busy: true });
    expect(buttons(busy).every((b) => b.props.disabled)).toBe(true);
    act(() => busy.unmount());
  });

  it('a row still waiting to be read carries no unsent line', () => {
    const r = render(<ChatRows rows={[{ ...unsentRow, unsent: undefined }]} />, { resolve: vi.fn(), busy: false });
    expect(r.root.findAll((n) => n.type === 'div' && n.props['data-unsent'] !== undefined)).toHaveLength(0);
    act(() => r.unmount());
  });
});
