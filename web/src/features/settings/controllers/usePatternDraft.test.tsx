import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { usePatternDraft } from './usePatternDraft';

function Field({ value, onCommit }: { value: string[]; onCommit: (patterns: string[]) => void }) {
  return <input {...usePatternDraft(value, onCommit)} />;
}

describe('pattern draft', () => {
  it('saves a changed list on blur or Enter, and nothing when unchanged', () => {
    const onCommit = vi.fn();
    const view = create(<Field value={['a']} onCommit={onCommit} />);
    const input = () => view.root.findByType('input');
    act(() => input().props.onBlur());
    expect(onCommit).not.toHaveBeenCalled();
    act(() => input().props.onChange({ target: { value: 'a, b' } }));
    expect(input().props.value).toBe('a, b');
    act(() => input().props.onKeyDown({ key: 'Enter' }));
    expect(onCommit).toHaveBeenCalledWith(['a', 'b']);
  });

  it('shows a newly saved list in place of the draft', () => {
    const view = create(<Field value={['a']} onCommit={vi.fn()} />);
    act(() => view.root.findByType('input').props.onChange({ target: { value: 'typing' } }));
    act(() => view.update(<Field value={['a', 'c']} onCommit={vi.fn()} />));
    expect(view.root.findByType('input').props.value).toBe('a, c');
  });
});
