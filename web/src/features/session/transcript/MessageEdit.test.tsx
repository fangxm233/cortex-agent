import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';
import { ChatRows } from './MessageStream';
import { EditBox } from './MessageEdit';

describe('inline message editor', () => {
  it('uses an unfiltered card and stable input without changing keyboard actions', () => {
    const onCancel = vi.fn();
    const onSubmit = vi.fn();
    const tree = create(<LangProvider><EditBox initialText="Revised prompt"
      onCancel={onCancel} onSubmit={onSubmit} busy={false} /></LangProvider>);
    const input = tree.root.findByType('textarea');
    expect(input.parent!.props.style.background).toBe('var(--material-card-bg)');
    expect(input.parent!.props.style.backdropFilter).toBeUndefined();
    expect(input.props.style.background).toBe('var(--material-inset-bg)');
    act(() => input.props.onKeyDown({ key: 'Escape', preventDefault: vi.fn() }));
    act(() => input.props.onKeyDown({ key: 'Enter', ctrlKey: true, preventDefault: vi.fn() }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith('Revised prompt');
    act(() => tree.unmount());
  });

  it('keeps busy submission disabled', () => {
    const onSubmit = vi.fn();
    const tree = create(<LangProvider><EditBox initialText="Revised prompt"
      onCancel={vi.fn()} onSubmit={onSubmit} busy /></LangProvider>);
    expect(tree.root.findAllByType('button').at(-1)!.props.disabled).toBe(true);
    act(() => tree.root.findByType('textarea').props.onKeyDown({ key: 'Enter', metaKey: true, preventDefault: vi.fn() }));
    expect(onSubmit).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });
});


it('retains a failed edit and only closes after a successful retry', async () => {
  const onSubmit = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({});
  const tree = create(<LangProvider><ChatRows rows={[{ kind: 'user', text: 'Original', turnIndex: 0 }]}
    edit={{ running: false, busy: false, onSubmit }} /></LangProvider>);
  act(() => tree.root.findByProps({ 'aria-label': 'Edit message' }).props.onClick());
  act(() => tree.root.findByType('textarea').props.onChange({ target: { value: 'Revised', style: {}, scrollHeight: 20 } }));
  await act(async () => tree.root.findByType(EditBox).props.onSubmit('Revised'));
  expect(tree.root.findByType('textarea').props.value).toBe('Revised');
  await act(async () => tree.root.findByType(EditBox).props.onSubmit('Revised'));
  expect(tree.root.findAllByType('textarea')).toHaveLength(0);
  expect(onSubmit).toHaveBeenNthCalledWith(2, 0, 'Revised');
  act(() => tree.unmount());
});
