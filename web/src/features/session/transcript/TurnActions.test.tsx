import { act, create } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { LangProvider } from '@/i18n';
import { TurnActions } from './TurnActions';

describe('TurnActions', () => {
  it('shows when the reply landed beside copy, with no quote button', () => {
    const ts = new Date().toISOString();
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<LangProvider><TurnActions turn={{ text: 'the answer', ts }} /></LangProvider>); });
    const d = new Date(ts);
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    expect(tree.root.findAll((node) => node.type === 'span' && node.children.includes(hhmm))).toHaveLength(1);
    const labels = tree.root.findAll((node) => node.type === 'button').map((node) => node.props['aria-label']);
    expect(labels).toEqual(['Copy']);
  });
});
