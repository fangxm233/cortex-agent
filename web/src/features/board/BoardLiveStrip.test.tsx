import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardInfo, SessionInfo } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';

vi.mock('@/features/team/useWorkerQuestions', () => ({
  useWorkerQuestions: () => ({ lead2: 'Asks: Which split?' }),
}));

import { BoardLiveStrip, stripAge, stripDotStyle } from './BoardLiveStrip';

const BOARD: BoardInfo = {
  id: 'b1', projectId: 'p', slug: 'survey', title: 'Survey',
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
};
const session = (sessionId: string, over: Partial<SessionInfo> = {}): SessionInfo =>
  ({ sessionId, projectId: 'p', boardId: 'b1', running: false, awaitingInput: false, lastUsedAt: new Date().toISOString(), ...over }) as SessionInfo;

let mounted: ReactTestRenderer | null = null;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = null;
  vi.unstubAllGlobals();
});

function render(props: Partial<Parameters<typeof BoardLiveStrip>[0]> & { sessions: SessionInfo[] }): ReactTestRenderer {
  const full = {
    board: BOARD, decisionCount: 7, decisionsOpen: false, onToggleDecisions: vi.fn(), onOpenSession: vi.fn(), ...props,
  };
  act(() => { mounted = create(<LangProvider><BoardLiveStrip {...full} /></LangProvider>); });
  return mounted!;
}
const text = (n: ReactTestInstance): string =>
  n.children.map((c) => (typeof c === 'string' ? c : text(c))).join('');
const styles = (r: ReactTestRenderer): string =>
  JSON.stringify(r.root.findAll((n) => typeof n.type === 'string' && n.props.style).map((n) => n.props.style));

describe('BoardLiveStrip', () => {
  it('is one line of sessions, each a status dot, its name and a short state, with decisions as a text link', () => {
    const onToggle = vi.fn();
    const r = render({
      sessions: [session('lead', { label: 'Plan' }), session('w1', { teamLeadId: 'lead', workerName: 'sweep', running: true })],
      onToggleDecisions: onToggle,
    });
    const rows = r.root.findAll((n) => n.type === 'button' && n.props['data-board-session'] !== undefined);
    expect(rows.map((n) => n.props['data-board-session'])).toEqual(['lead', 'w1']);
    expect(rows.map((n) => n.find((c) => c.props['data-board-dot'] !== undefined).props['data-board-dot'])).toEqual(['idle', 'running']);
    expect(text(rows[0]!)).toContain('Plan');

    const decisions = r.root.findByProps({ 'data-board-decisions': '' });
    expect(text(decisions)).toBe('Decisions 7›');
    expect(decisions.props.style.color).toBe('var(--proto-accent)');
    expect(decisions.props.style.background).toBe('transparent');
    act(() => decisions.props.onClick({ stopPropagation() {} }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(r.root.findAll((n) => n.props['data-board-pending'] !== undefined)).toHaveLength(0);
  });

  it('follows a name with its age only — the dot is the state, the wording is the tooltip and label', () => {
    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    const r = render({ sessions: [
      session('lead', { label: 'Plan', lastUsedAt: ago(20) }),
      session('w1', { teamLeadId: 'lead', workerName: 'sweep', running: true, lastUsedAt: ago(11) }),
      session('w2', { teamLeadId: 'lead', workerName: 'eval', waitingOn: 1, lastUsedAt: ago(3) }),
    ] });
    const row = (id: string) => r.root.findByProps({ 'data-board-session': id });
    expect(['lead', 'w1', 'w2'].map((id) => text(row(id)))).toEqual(['Plan20m', 'sweep11m', 'eval3m']);
    expect(row('lead').props.title).toBe('Plan · idle 20m');
    expect(row('w1').props['aria-label']).toBe('sweep · running 11m');
    expect(row('w2').props.title).toBe('eval · waiting');
    // Sessions share the line and truncate their names before it wraps.
    expect(row('lead').props.style).toMatchObject({ flex: '1 1 0', maxWidth: 'max-content' });
  });

  it('underlines only the link words on hover, never the chevron that rotates', () => {
    const decisions = render({ sessions: [] }).root.findByProps({ 'data-board-decisions': '' });
    expect(decisions.props.className).not.toContain('underline');
    const [words, chevron] = decisions.children as ReactTestInstance[];
    expect(words!.props.className).toContain('group-hover/strip-link:underline');
    expect(chevron!.props.className ?? '').not.toContain('underline');
  });

  it('names the board only when the host does not', () => {
    const titled = render({ sessions: [] });
    expect(text(titled.root.findByProps({ 'data-board-strip-title': '' }))).toContain('Survey');
    act(() => mounted!.unmount());
    const docked = render({ sessions: [], showTitle: false });
    expect(docked.root.findAll((n) => n.props['data-board-strip-title'] !== undefined)).toHaveLength(0);
    expect(text(docked.root.findByProps({ 'data-board-strip': '' }))).toContain('No sessions on this board');
  });

  it('adds an amber link while sessions wait on the user: one opens it, several list their questions', () => {
    const onOpen = vi.fn();
    const one = render({ sessions: [session('lead', { label: 'Plan', awaitingInput: true })], onOpenSession: onOpen });
    const link = one.root.findByProps({ 'data-board-pending': '' });
    expect(text(link)).toBe('1 awaiting you›');
    expect(link.props.style.color).toBe('var(--proto-amber-fg)');
    act(() => link.props.onClick({ stopPropagation() {} }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'lead' }));
    act(() => mounted!.unmount());

    // The list closes on an outside click or Escape, which it listens for on the window.
    vi.stubGlobal('window', new EventTarget());
    const many = render({ sessions: [session('lead', { awaitingInput: true }), session('lead2', { awaitingInput: true })], onOpenSession: onOpen });
    act(() => many.root.findByProps({ 'data-board-pending': '' }).props.onClick({ stopPropagation() {} }));
    expect(text(many.root.findByProps({ 'data-board-pending-list': '' }))).toContain('Asks: Which split?');
  });

  it('keeps the code face out of the strip', () => {
    const r = render({ sessions: [session('lead', { awaitingInput: true }), session('w1', { teamLeadId: 'lead', workerName: 'sweep' })] });
    expect(styles(r)).not.toMatch(/Plex Mono|monospace/);
  });
});

describe('stripAge', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  const at = (min: number) => new Date(now - min * 60_000).toISOString();
  it('is the shared span format in either language, whatever the state, and nothing when unknown', () => {
    expect(stripAge(session('a', { lastUsedAt: at(20) }), now, 'en')).toBe('20m');
    expect(stripAge(session('a', { lastUsedAt: at(20) }), now, 'zh')).toBe('20分钟');
    expect(stripAge(session('a', { running: true, lastUsedAt: at(4) }), now, 'en')).toBe('4m');
    expect(stripAge(session('a', { lastUsedAt: 'nope' }), now, 'en')).toBeNull();
  });
});

describe('stripDotStyle', () => {
  it('is the rail dot, but an idle session is a light hollow ring and a running one breathes', () => {
    expect(stripDotStyle(session('a'))).toMatchObject({ background: 'transparent', border: expect.stringContaining('solid') });
    expect(stripDotStyle(session('a', { running: true }))).toMatchObject({ background: 'var(--proto-accent)', animation: expect.stringContaining('cxring') });
    expect(stripDotStyle(session('a', { awaitingInput: true }))).toMatchObject({ background: 'var(--proto-amber)' });
    expect(stripDotStyle(session('a', { waitingOn: 1 }))).toMatchObject({ border: '1.5px solid var(--proto-muted-3)' });
  });
});
