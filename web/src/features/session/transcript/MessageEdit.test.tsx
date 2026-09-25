// input:  EditBox, edit copy, React renderer
// output: Inline editor material and keyboard regression tests
// pos:    Verify stable input surfaces and edit actions
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { EditBox, M_EDIT_COPY } from './MessageEdit';

describe('inline message editor', () => {
  it('uses an unfiltered card and stable input without changing keyboard actions', () => {
    const onCancel = vi.fn();
    const onSubmit = vi.fn();
    const tree = create(<EditBox initialText="Revised prompt" copy={M_EDIT_COPY.en}
      onCancel={onCancel} onSubmit={onSubmit} busy={false} />);
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
    const tree = create(<EditBox initialText="Revised prompt" copy={M_EDIT_COPY.en}
      onCancel={vi.fn()} onSubmit={onSubmit} busy />);
    expect(tree.root.findAllByType('button').at(-1)!.props.disabled).toBe(true);
    act(() => tree.root.findByType('textarea').props.onKeyDown({ key: 'Enter', metaKey: true, preventDefault: vi.fn() }));
    expect(onSubmit).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });
});
