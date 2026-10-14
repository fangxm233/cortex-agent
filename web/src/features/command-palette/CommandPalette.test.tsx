import type { ReactNode } from 'react';
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';

const h = vi.hoisted(() => ({
  navigate: vi.fn(), project: vi.fn(), session: vi.fn(), settings: vi.fn(),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => h.navigate }));
vi.mock('@/features/projects/CurrentProjectProvider', () => ({ useCurrentProject: () => ({ setCurrentProject: h.project }) }));
vi.mock('@/features/session/state/SelectedSessionProvider', () => ({ useSelectedSession: () => ({ setSelectedSession: h.session }) }));
vi.mock('@/features/settings/useSettings', () => ({ useSettings: () => ({ open: h.settings }) }));
vi.mock('@/lib/trpc', () => ({ useTRPC: () => ({
  sessions: { list: { queryOptions: () => ({ queryKey: ['sessions'] }) } },
  boards: { list: { queryOptions: () => ({ queryKey: ['boards'] }) } },
}) }));
const BOARDS = [
  { id: 'b-done', projectId: 'orchard', slug: 'done', title: 'Done board', status: 'done', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-09T00:00:00Z', closedAt: '2026-07-09T00:00:00Z', closeNote: null },
  { id: 'b-open', projectId: 'orchard', slug: 'open', title: 'Open board', status: 'active', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-02T00:00:00Z', closedAt: null, closeNote: null },
];
vi.mock('@tanstack/react-query', () => ({
  useQuery: (o: { queryKey: string[] }) => ({ data: o.queryKey[0] === 'boards' ? BOARDS : [{ sessionId: 's1', projectId: 'orchard', label: 'Session' }] }),
}));
vi.mock('cmdk', () => {
  const wrapper = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return { Command: {
    Dialog: wrapper, List: wrapper, Empty: wrapper,
    Input: () => null,
    Item: ({ children, onSelect, value, 'data-closed': closed }: { children: ReactNode; onSelect: () => void; value: string; 'data-closed'?: string }) =>
      <button data-item={value} data-closed={closed} onClick={onSelect}>{children}</button>,
  } };
});

import { CommandPalette } from './CommandPalette';

it('selects the session in its own project before navigating to the workbench', () => {
  const close = vi.fn();
  const tree = create(<LangProvider><CommandPalette open onOpenChange={close} /></LangProvider>);
  act(() => tree.root.findByProps({ 'data-item': 'session:s1' }).props.onClick());
  expect(close).toHaveBeenCalledWith(false);
  expect(h.project).toHaveBeenCalledWith('orchard');
  expect(h.session).toHaveBeenCalledWith('s1');
  expect(h.navigate).toHaveBeenCalledWith('/workbench');
  expect(h.project.mock.invocationCallOrder[0]).toBeLessThan(h.session.mock.invocationCallOrder[0]);
  expect(h.session.mock.invocationCallOrder[0]).toBeLessThan(h.navigate.mock.invocationCallOrder[0]);
  act(() => tree.unmount());
});

it('shows closed boards after open ones, marked closed, without a query', () => {
  const tree = create(<LangProvider><CommandPalette open onOpenChange={vi.fn()} /></LangProvider>);
  const rows = tree.root.findAll((n) => n.type === 'button' && n.props['data-item'] !== undefined);
  const boards = rows.filter((n) => String(n.props['data-item']).startsWith('board:'));
  expect(boards.map((n) => [n.props['data-item'], n.props['data-closed']])).toEqual([
    ['board:b-open', undefined], ['board:b-done', ''],
  ]);
  act(() => tree.unmount());
});
