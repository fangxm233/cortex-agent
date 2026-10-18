import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardDecisionEntry } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';

const h = vi.hoisted(() => ({ respond: vi.fn(), sessions: [] as string[] }));
vi.mock('@/features/session/interaction/useDecisionActions', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/features/session/interaction/useDecisionActions')>();
  return {
    ...real,
    useDecisionActions: (sessionId: string) => {
      h.sessions.push(sessionId);
      return { respond: (...args: unknown[]) => h.respond(sessionId, ...args), busy: false };
    },
  };
});

import { BoardDecisionStream } from './BoardDecisionStream';
import { messageTimeLabel } from '@/features/session/transcript/transcript-vm';

const entry = (id: string, sessionId: string, title: string, actions: BoardDecisionEntry['item']['actions'] = []): BoardDecisionEntry => ({
  ts: '2026-10-13T22:00:00.000Z',
  sessionId,
  item: { id, title, decision: 'd', context: 'c', reasoning: 'r', actions },
});

let mounted: ReactTestRenderer | null = null;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = null;
  h.respond.mockReset();
  h.sessions = [];
});

function render(decisions: BoardDecisionEntry[]): ReactTestRenderer {
  act(() => { mounted = create(<LangProvider><BoardDecisionStream decisions={decisions} /></LangProvider>); });
  return mounted!;
}
const text = (n: ReactTestInstance): string =>
  n.children.map((c) => (typeof c === 'string' ? c : text(c))).join('');

describe('BoardDecisionStream', () => {
  it('shows the cards newest first with their status and no source heading', () => {
    const r = render([
      entry('d1', 'lead-session', 'First', [{ action: 'approve', ts: '2026-10-13T22:01:00.000Z' }]),
      entry('d2', 'worker-session', 'Second'),
    ]);
    const toggles = r.root.findAll((n) => n.type === 'button' && n.props['data-decision-toggle'] !== undefined);
    expect(toggles.map((n) => n.props['data-decision-toggle'])).toEqual(['d2', 'd1']);
    const all = text(r.root.findByProps({ 'data-board-decision-stream': '' }));
    expect(all).toContain('Approved');
    // Every line here is a decision: no repeated label, and an unanswered one is dated by its announcement.
    expect(all).not.toContain('Decision');
    expect(text(r.root.findByProps({ 'data-decision-toggle': 'd2' }))).toBe(`Second${messageTimeLabel('2026-10-13T22:00:00.000Z')}`);
    expect(all).not.toContain('lead-session');
    expect(all).not.toContain('worker-session');
  });

  it('says so in one muted line of the app face when there is nothing yet', () => {
    const stream = render([]).root.findByProps({ 'data-board-decision-stream': '' });
    expect(text(stream)).toBe('No decisions recorded yet.');
    const line = stream.children[0] as ReactTestInstance;
    expect(line.props.style).toMatchObject({ color: 'var(--proto-muted)' });
    expect(JSON.stringify(line.props.style)).not.toMatch(/font"|Mono|monospace/);
  });

  it('answers a decision on the session that announced it', () => {
    const r = render([entry('d1', 'lead-session', 'First'), entry('d2', 'worker-session', 'Second')]);
    act(() => r.root.findByProps({ 'data-decision-toggle': 'd2' }).props.onClick());
    const approve = r.root.findAll((n) => n.type === 'button' && text(n).includes('Approve'))[0];
    act(() => approve.props.onClick());
    expect(h.respond).toHaveBeenCalledWith('worker-session', 'd2', 'approve');
    expect(new Set(h.sessions)).toEqual(new Set(['lead-session', 'worker-session']));
  });
});
