import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { en } from '@/i18n/vocab';
import type { AutostartController } from '@/features/settings/controllers/useAutostartController';
import { SetupAutostartCard } from '@/features/provider-setup/SetupAutostartCard';
import { AutostartCardView } from './AutostartCard';

vi.mock('@/i18n', async importOriginal => ({ ...await importOriginal<typeof import('@/i18n')>(), useVocab: () => en }));

function controller(patch: Partial<AutostartController> = {}): AutostartController {
  return { state: 'off', pending: false, failed: false, set: vi.fn(), ...patch };
}

const CARDS = [
  ['Settings → Advanced', (c: AutostartController) => <AutostartCardView controller={c} />],
  ['post-install page', (c: AutostartController) => <SetupAutostartCard controller={c} />],
] as const;

describe.each(CARDS)('start at login (%s)', (_name, card) => {
  function render(c: AutostartController): ReactTestRenderer {
    let tree!: ReactTestRenderer;
    act(() => { tree = create(card(c)); });
    return tree;
  }
  const toggle = (tree: ReactTestRenderer) => tree.root.find((n) => n.props.role === 'switch');
  const text = (tree: ReactTestRenderer) => JSON.stringify(tree.toJSON());

  it('switches to the opposite of what is registered', () => {
    const off = controller();
    const offTree = render(off);
    act(() => toggle(offTree).props.onClick());
    expect(off.set).toHaveBeenCalledWith(true);
    const on = controller({ state: 'on' });
    const tree = render(on);
    expect(toggle(tree).props['aria-checked']).toBe(true);
    expect(text(tree)).toContain(en.autostartDesc);
    act(() => toggle(tree).props.onClick());
    expect(on.set).toHaveBeenCalledWith(false);
  });

  it('is read-only when the terminal set it up', () => {
    const tree = render(controller({ state: 'external' }));
    expect(toggle(tree).props.onClick).toBeUndefined();
    expect(text(tree)).toContain(en.autostartExternal);
  });

  it('cannot be clicked again while a change is in flight', () => {
    expect(toggle(render(controller({ pending: true }))).props.onClick).toBeUndefined();
  });

  it('reports a failed change', () => {
    const tree = render(controller({ failed: true }));
    expect(tree.root.find((n) => n.props.role === 'alert').children.join('')).toBe(en.autostartFailed);
  });

  it('is hidden where there is nothing to offer', () => {
    expect(render(controller({ state: null })).toJSON()).toBeNull();
  });
});
