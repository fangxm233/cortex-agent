import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { TelemetryInfo } from '@cortex-agent/ui-contract';
import { en } from '@/i18n/vocab';
import type { PrivacyController } from '@/features/settings/controllers/usePrivacyController';
import { PrivacyPanelView } from './PrivacyPanel';

vi.mock('@/i18n', async importOriginal => ({ ...await importOriginal<typeof import('@/i18n')>(), useVocab: () => en }));

const ID = '0f8b5c1e-3a7d-4e2b-9c41-6d2a8e5f7b90';

function controller(data: TelemetryInfo | undefined, patch: Partial<PrivacyController> = {}): PrivacyController {
  const info = { data, isLoading: false } as PrivacyController['info'];
  return { info, pending: false, setEnabled: vi.fn(), ...patch };
}

function render(c: PrivacyController): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => { tree = create(<PrivacyPanelView controller={c} />); });
  return tree;
}

const text = (tree: ReactTestRenderer) => JSON.stringify(tree.toJSON());
const toggle = (tree: ReactTestRenderer) => tree.root.find((n) => n.props.role === 'switch');

describe('PrivacyPanelView', () => {
  it('shows the switch, the docs link and the install id', () => {
    const c = controller({ settingEnabled: true, active: true, inactiveReason: null, installId: ID });
    const tree = render(c);
    expect(toggle(tree).props['aria-checked']).toBe(true);
    expect(tree.root.findByType('a').props.href).toBe(en.tmDocsUrl);
    expect(text(tree)).toContain(ID);
    act(() => toggle(tree).props.onClick());
    expect(c.setEnabled).toHaveBeenCalledWith(false);
  });

  it('locks the switch with a reason when something else decides', () => {
    const c = controller({ settingEnabled: true, active: false, inactiveReason: 'do-not-track', installId: ID });
    const tree = render(c);
    expect(toggle(tree).props.onClick).toBeUndefined();
    expect(text(tree)).toContain(en.tmReasonDnt);
  });

  it('says when the server could not answer', () => {
    expect(text(render(controller(undefined)))).toContain(en.tmLoadFailed);
  });
});
