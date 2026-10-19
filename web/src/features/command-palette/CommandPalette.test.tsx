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
  { id: 'b-recent', projectId: 'orchard', slug: 'recent', title: 'Recent board', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-09T00:00:00Z' },
  { id: 'b-older', projectId: 'orchard', slug: 'older', title: 'Older board', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-02T00:00:00Z' },
];
vi.mock('@tanstack/react-query', () => ({
  useQuery: (o: { queryKey: string[] }) => ({ data: o.queryKey[0] === 'boards' ? BOARDS
    : o.queryKey[0] === 'agent-browser' ? [] : [{ sessionId: 's1', projectId: 'orchard', label: 'Session' }] }),
}));
vi.mock('cmdk', () => {
  const wrapper = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return { Command: {
    Dialog: wrapper, List: wrapper, Empty: wrapper,
    Group: ({ children, heading }: { children: ReactNode; heading: ReactNode }) =>
      <section data-group>{heading}{children}</section>,
    Input: () => null,
    Item: ({ children, onSelect, value }: { children: ReactNode; onSelect: () => void; value: string }) =>
      <button data-item={value} onClick={onSelect}>{children}</button>,
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

it('lists the recent boards in the server\'s order without a query', () => {
  const tree = create(<LangProvider><CommandPalette open onOpenChange={vi.fn()} /></LangProvider>);
  const rows = tree.root.findAll((n) => n.type === 'button' && n.props['data-item'] !== undefined);
  expect(rows.map((n) => String(n.props['data-item'])).filter((id) => id.startsWith('board:')))
    .toEqual(['board:b-recent', 'board:b-older']);
  act(() => tree.unmount());
});

it('heads each run of rows with a sentence-case group name instead of a mono kind column', () => {
  const tree = create(<LangProvider><CommandPalette open onOpenChange={vi.fn()} /></LangProvider>);
  const groups = tree.root.findAll((n) => n.type === 'section' && n.props['data-group'] !== undefined);
  const heading = (n: (typeof groups)[number]) => n.findByType('div').children.join('');
  expect(groups.map(heading)).toEqual(['Pages', 'Actions', 'Boards', 'Sessions']);
  const json = JSON.stringify(tree.toJSON());
  expect(json).not.toContain('IBM Plex Mono');
  expect(json).not.toContain('uppercase');
  // No close chip in the header: Escape is shown as a key hint in the footer instead.
  expect(tree.root.findAll((n) => n.type === 'button' && n.children.includes('esc'))).toHaveLength(0);
  expect(tree.root.findAllByType('kbd').map((n) => n.children.join(''))).toEqual(['↑', '↓', '↵', 'esc']);
  act(() => tree.unmount());
});
