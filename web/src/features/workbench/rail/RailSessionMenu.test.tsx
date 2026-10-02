import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as Popover from '@radix-ui/react-popover';
import { RailSessionMenu } from './RailSessionMenu';
import type { RailSessionRow } from './rail-tree';

const rpc = vi.hoisted(() => ({ star: vi.fn(), rename: vi.fn() }));
vi.mock('@/lib/trpc', () => ({ useTRPC: () => ({ sessions: {
  setStarred: { mutationOptions: () => ({ mutationFn: rpc.star }) },
  rename: { mutationOptions: () => ({ mutationFn: rpc.rename }) },
  list: { queryFilter: () => ({ queryKey: ['sessions', 'list'] }) },
} }) }));
vi.mock('@/i18n', () => ({ useLang: () => 'en' }));
vi.mock('@radix-ui/react-popover', () => ({
  Root: ({ children }: any) => children,
  Trigger: ({ children }: any) => children,
  Portal: ({ children }: any) => children,
  Content: ({ children }: any) => <section>{children}</section>,
}));
vi.mock('@/design/Modal', () => ({ Modal: ({ open, children }: any) =>
  open ? <section role="dialog">{children}</section> : null }));

const row: RailSessionRow = { sessionId: 'not-selected', projectId: 'p1', title: 'Other session',
  age: '5m', stamp: '', running: false, awaitingInput: false, waitingOn: false, unread: false, selected: false };
let renderer: ReactTestRenderer;
let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  rpc.star.mockReset().mockImplementation(async (input) => input);
  rpc.rename.mockReset().mockImplementation(async (input) => input);
});
afterEach(() => { act(() => renderer?.unmount()); client.clear(); vi.useRealTimers(); });
function mount(session = row, focus = vi.fn()) {
  act(() => { renderer = create(<QueryClientProvider client={client}>
    <RailSessionMenu row={session} hovered={false} />
  </QueryClientProvider>, { createNodeMock: node => node.type === 'button' ? { focus } : null }); });
}
function open(value = true) {
  act(() => renderer.root.findByType(Popover.Root).props.onOpenChange(value));
}
function button(label: string) {
  return renderer.root.findAllByType('button').find(node => node.children.includes(label))!;
}
async function click(label: string) {
  await act(async () => button(label).props.onClick());
}
const trigger = () => renderer.root.findAllByType('button').find(node => node.props['aria-label'] === 'Session menu: Other session')!;
const boundary = () => renderer.root.findAllByType('span').find(node => node.props.onFocus)!;
const age = () => renderer.root.findAllByType('span').find(node => node.children.includes('5m'))!;

it('swaps age for a tabbable button on hover/focus without requiring QueryClient for idle rows', () => {
  act(() => { renderer = create(<RailSessionMenu row={row} hovered={false} />); });
  expect(age().props.style.visibility).toBe('visible');
  expect(trigger().props.style.opacity).toBe(0);
  expect(trigger().props.tabIndex).toBeUndefined();
  act(() => renderer.update(<RailSessionMenu row={row} hovered />));
  expect(age().props.style.visibility).toBe('hidden');
  expect(trigger().props.style.opacity).toBe(1);
  act(() => renderer.update(<RailSessionMenu row={row} hovered={false} />));
  act(() => boundary().props.onFocus());
  expect(age().props.style.visibility).toBe('hidden');
  act(() => boundary().props.onBlur());
  expect(age().props.style.visibility).toBe('visible');
  expect(boundary().props.style).toMatchObject({ minWidth: 22, height: 22, flex: 'none' });
});

it('keeps the open menu visible without hover and targets the non-selected row for star/unstar', async () => {
  mount(); open();
  expect(trigger().props.style.opacity).toBe(1);
  await click('Star');
  expect(rpc.star).toHaveBeenLastCalledWith({ sessionId: row.sessionId, starred: true }, expect.anything());
  expect(renderer.root.findByType(Popover.Root).props.open).toBe(false);
  open(); await click('Unstar');
  expect(rpc.star).toHaveBeenLastCalledWith({ sessionId: row.sessionId, starred: false }, expect.anything());
});

it('offers Unstar for an already starred row', async () => {
  mount({ ...row, starred: true }); open(); await click('Unstar');
  expect(rpc.star).toHaveBeenCalledWith({ sessionId: row.sessionId, starred: false }, expect.anything());
});

it('keeps rename mounted after menu dismissal, preserves input, cancels and saves by row ID', async () => {
  mount(); open(); await click('Rename');
  expect(renderer.root.findByType(Popover.Root).props.open).toBe(false);
  const autoFocus = { preventDefault: vi.fn() };
  renderer.root.findByType(Popover.Content).props.onCloseAutoFocus(autoFocus);
  expect(autoFocus.preventDefault).toHaveBeenCalledOnce();
  expect(renderer.root.findByType('input').props.value).toBe(row.title);
  act(() => renderer.root.findByType('input').props.onChange({ target: { value: 'Changed' } }));
  open(false);
  expect(renderer.root.findByType('input').props.value).toBe('Changed');
  await click('Cancel');
  expect(renderer.root.findAllByType('input')).toHaveLength(0);
  expect(rpc.rename).not.toHaveBeenCalled();
  open(); await click('Rename');
  expect(renderer.root.findByType('input').props.value).toBe(row.title);
  act(() => renderer.root.findByType('input').props.onChange({ target: { value: '  Renamed  ' } }));
  await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  expect(rpc.rename).toHaveBeenCalledWith({ sessionId: row.sessionId, label: 'Renamed' }, expect.anything());
  expect(renderer.root.findAllByType('input')).toHaveLength(0);
});

it('blocks bubbling at the ancestor shared by the trigger, popup and metadata dialog portals', () => {
  mount(); open();
  // Pointerdown must reach Radix's document listener, or the next outside click is swallowed.
  expect(boundary().props.onPointerDown).toBeUndefined();
  for (const handler of ['onClick', 'onKeyDown']) {
    const stopPropagation = vi.fn();
    boundary().props[handler]({ stopPropagation });
    expect(stopPropagation).toHaveBeenCalledOnce();
  }
});

it('returns focus to this row after its rename dialog closes', async () => {
  vi.useFakeTimers();
  const focus = vi.fn();
  mount(row, focus); open(); await click('Rename');
  expect(focus).not.toHaveBeenCalled();
  await click('Cancel');
  act(() => { vi.runOnlyPendingTimers(); });
  expect(focus).toHaveBeenCalledOnce();
});

it('accepts Radix dismissal and leaves normal popover focus return enabled', () => {
  mount(); open(); open(false);
  expect(age().props.style.visibility).toBe('visible');
  const preventDefault = vi.fn();
  renderer.root.findByType(Popover.Content).props.onCloseAutoFocus({ preventDefault });
  expect(preventDefault).not.toHaveBeenCalled();
});
