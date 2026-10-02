import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionMetadata, type MetadataSession } from './SessionMetadata';
import { SessionMetadataMenuItems } from './SessionMetadataMenuItems';

const rpc = vi.hoisted(() => ({ star: vi.fn(), rename: vi.fn() }));
vi.mock('@/lib/trpc', () => ({ useTRPC: () => ({ sessions: {
  setStarred: { mutationOptions: () => ({ mutationFn: rpc.star }) },
  rename: { mutationOptions: () => ({ mutationFn: rpc.rename }) },
  list: { queryFilter: () => ({ queryKey: ['sessions', 'list'] }) },
} }) }));
vi.mock('@/i18n', () => ({ useLang: () => 'en' }));
vi.mock('@/design/Modal', () => ({ Modal: ({ open, children, footer }: any) =>
  open ? <section role="dialog">{children}{footer}</section> : null }));

const first = { sessionId: 'stable-1', title: 'Current title', starred: false };
let renderer: ReactTestRenderer;
let client: QueryClient;
function tree(session: MetadataSession | null, touch = false) {
  return <QueryClientProvider client={client}><SessionMetadata session={session}>
    {(actions) => <SessionMetadataMenuItems actions={actions} touch={touch} onClose={() => {}} />}
  </SessionMetadata></QueryClientProvider>;
}
function mount(session: MetadataSession | null = first, touch = false) {
  act(() => { renderer = create(tree(session, touch)); });
}
function button(label: string) {
  return renderer.root.findAllByType('button').find((node) => node.children.includes(label))!;
}
async function click(label: string) {
  await act(async () => { button(label).props.onClick?.(); });
}
function change(value: string) {
  act(() => renderer.root.findByType('input').props.onChange({ target: { value } }));
}
async function save() {
  await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
}
function deferred() {
  let resolve!: (value: any) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  vi.spyOn(client, 'invalidateQueries');
  rpc.star.mockReset().mockImplementation(async (input) => input);
  rpc.rename.mockReset().mockImplementation(async (input) => input);
});
afterEach(() => { act(() => renderer?.unmount()); client.clear(); });

describe.each([false, true])('shared metadata menu (touch=%s)', (touch) => {
  it('stars and unstars by stable ID, invalidating all session lists', async () => {
    mount(first, touch);
    await click('Star');
    expect(rpc.star).toHaveBeenLastCalledWith({ sessionId: 'stable-1', starred: true }, expect.anything());
    await click('Unstar');
    expect(rpc.star).toHaveBeenLastCalledWith({ sessionId: 'stable-1', starred: false }, expect.anything());
    expect(client.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['sessions', 'list'] });
  });
  it('disables actions for a draft', async () => {
    mount(null, touch);
    expect(button('Star').props.disabled).toBe(true);
    expect(button('Rename').props.disabled).toBe(true);
    await click('Star');
    await click('Rename');
    expect(rpc.star).not.toHaveBeenCalled();
    expect(renderer.root.findAllByType('input')).toHaveLength(0);
  });
});
it('prefills, cancels without mutation, and resets the next rename', async () => {
  mount(); await click('Rename');
  expect(renderer.root.findByType('input').props.value).toBe('Current title');
  change('Discard me'); await click('Cancel');
  expect(rpc.rename).not.toHaveBeenCalled();
  await click('Rename');
  expect(renderer.root.findByType('input').props.value).toBe('Current title');
});
it('rejects empty and overlong trimmed titles; saves only a trimmed display label', async () => {
  mount(); await click('Rename');
  for (const value of ['   ', 'x'.repeat(61)]) {
    change(value); expect(button('Save').props.disabled).toBe(true); await save();
  }
  expect(rpc.rename).not.toHaveBeenCalled();
  change(`  ${'x'.repeat(60)}  `); await save();
  expect(rpc.rename).toHaveBeenCalledWith({ sessionId: 'stable-1', label: 'x'.repeat(60) }, expect.anything());
  expect(renderer.root.findAllByType('input')).toHaveLength(0);
  expect(client.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['sessions', 'list'] });
});
it('retains the draft and shows a failed rename, allowing retry', async () => {
  rpc.rename.mockRejectedValueOnce(new Error('Rename failed'));
  mount(); await click('Rename'); change('New title'); await save();
  expect(renderer.root.findByProps({ role: 'alert' }).children).toContain('Rename failed');
  expect(renderer.root.findByType('input').props.value).toBe('New title');
  expect(client.invalidateQueries).not.toHaveBeenCalled();
  await save(); expect(renderer.root.findAllByType('input')).toHaveLength(0);
});
it('locks duplicate submits synchronously while rename is pending', async () => {
  const gate = deferred(); rpc.rename.mockReturnValue(gate.promise);
  mount(); await click('Rename'); change('New title');
  await act(async () => {
    const submit = renderer.root.findByType('form').props.onSubmit;
    submit({ preventDefault() {} }); submit({ preventDefault() {} });
  });
  expect(rpc.rename).toHaveBeenCalledTimes(1);
  expect(button('Saving…').props.disabled).toBe(true);
  await act(async () => gate.resolve({ sessionId: 'stable-1', label: 'New title' }));
});
it('clears drafts on switches and ignores a previous session failure', async () => {
  const gate = deferred(); rpc.rename.mockReturnValueOnce(gate.promise);
  mount(); await click('Rename'); change('Old draft'); await save();
  act(() => renderer.update(tree({ sessionId: 'stable-2', title: 'Second', starred: true })));
  expect(renderer.root.findAllByType('input')).toHaveLength(0);
  await click('Rename');
  expect(renderer.root.findByType('input').props.value).toBe('Second');
  await act(async () => gate.reject(new Error('Old failure')));
  expect(renderer.root.findAllByProps({ role: 'alert' })).toHaveLength(0);
  change('Second renamed'); await save();
  expect(rpc.rename).toHaveBeenLastCalledWith({ sessionId: 'stable-2', label: 'Second renamed' }, expect.anything());
  act(() => renderer.update(tree(null)));
  expect(button('Star').props.disabled).toBe(true);
});
it('shows star failures without claiming success and blocks duplicate toggles', async () => {
  const gate = deferred(); rpc.star.mockReturnValue(gate.promise);
  mount(); await act(async () => {
    const toggle = button('Star').props.onClick; toggle(); toggle();
  });
  expect(rpc.star).toHaveBeenCalledTimes(1);
  await act(async () => gate.reject(new Error('Star failed')));
  expect(renderer.root.findByProps({ role: 'alert' }).children).toContain('Star failed');
  expect(button('Star').props.disabled).toBe(false);
  expect(client.invalidateQueries).not.toHaveBeenCalled();
});
