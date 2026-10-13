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
vi.mock('@/lib/trpc', () => ({ useTRPC: () => ({ sessions: { list: { queryOptions: () => ({}) } } }) }));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: [{ sessionId: 's1', projectId: 'orchard', name: 'Session' }] }) }));
vi.mock('cmdk', () => {
  const wrapper = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return { Command: {
    Dialog: wrapper, List: wrapper, Empty: wrapper,
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
