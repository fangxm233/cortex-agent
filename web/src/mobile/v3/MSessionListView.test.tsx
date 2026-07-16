import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { MSessionListView, type MSessionListCopy } from './MSessionListView';
import { buildSessionGroups } from './m-session-list-vm';

const copy: MSessionListCopy = {
  title: '会话',
  today: '今天',
  yesterday: '昨天',
  earlier: '更早',
  empty: '暂无会话',
};

function sess(over: Partial<SessionInfo>): SessionInfo {
  return {
    sessionId: 's1',
    name: 'morning review',
    projectId: 'nimbus',
    backend: 'anthropic',
    kind: 'local',
    origin: 'direct',
    createdAt: '2026-07-15T09:00:00Z',
    lastUsedAt: '2026-07-15T09:00:00Z',
    resumable: true,
    label: null,
    profileName: null,
    running: false,
    numTurns: null,
    unread: false,
    ...over,
  };
}

function render(sessions: SessionInfo[]) {
  const now = Date.parse('2026-07-15T12:00:00Z');
  const groups = buildSessionGroups(sessions, now);
  return renderToStaticMarkup(
    <MSessionListView
      groups={groups}
      sessions={sessions}
      scope="NI"
      copy={copy}
      onOpen={() => {}}
      onNew={() => {}}
    />,
  );
}

describe('MSessionListView', () => {
  it('renders the header title, the passive scope tag, and the ＋ button', () => {
    const html = render([sess({})]);
    expect(html).toContain('会话');
    expect(html).toContain('NI');
    expect(html).toContain('＋');
  });

  it('renders a running row with the real turn count (no fabricated cost)', () => {
    const html = render([sess({ running: true, numTurns: 12 })]);
    expect(html).toContain('running · 12 turns');
    expect(html).not.toContain('$');
    expect(html).toContain('#4655D4'); // running dot
  });

  it('renders an idle row as 空闲', () => {
    const html = render([sess({ running: false })]);
    expect(html).toContain('空闲');
  });

  it('renders the day group label', () => {
    const html = render([sess({ lastUsedAt: '2026-07-15T11:00:00Z' })]);
    expect(html).toContain('今天');
  });

  it('shows the empty state when there are no sessions', () => {
    const html = render([]);
    expect(html).toContain('暂无会话');
  });
});
