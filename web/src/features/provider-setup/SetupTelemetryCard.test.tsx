import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { TelemetryInfo } from '@cortex-agent/ui-contract';
import { en } from '@/i18n/vocab';
import type { PrivacyController } from '@/features/settings/controllers/usePrivacyController';
import { SetupTelemetryCard } from './SetupTelemetryCard';

vi.mock('@/i18n', async importOriginal => ({ ...await importOriginal<typeof import('@/i18n')>(), useVocab: () => en }));

const ID = '0f8b5c1e-3a7d-4e2b-9c41-6d2a8e5f7b90';

function controller(data: TelemetryInfo | undefined, patch: Partial<PrivacyController> = {}): PrivacyController {
  return { info: { data } as PrivacyController['info'], pending: false, setEnabled: vi.fn(), ...patch };
}

function render(c: PrivacyController): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => { tree = create(<SetupTelemetryCard controller={c} />); });
  return tree;
}

const toggle = (tree: ReactTestRenderer) => tree.root.find((n) => n.props.role === 'switch');

describe('SetupTelemetryCard', () => {
  it('offers the real setting with its description and docs link', () => {
    const c = controller({ settingEnabled: true, active: true, inactiveReason: null, installId: ID });
    const tree = render(c);
    expect(toggle(tree).props['aria-checked']).toBe(true);
    expect(JSON.stringify(tree.toJSON())).toContain(en.tmShareDesc);
    expect(tree.root.findByType('a').props.href).toBe(en.tmDocsUrl);
    act(() => toggle(tree).props.onClick());
    expect(c.setEnabled).toHaveBeenCalledWith(false);
  });

  it('is read-only with the reason when something other than the setting decides', () => {
    const tree = render(controller({ settingEnabled: true, active: false, inactiveReason: 'env', installId: ID }));
    expect(toggle(tree).props.onClick).toBeUndefined();
    expect(tree.root.findByProps({ 'data-telemetry-locked': true }).children.join('')).toBe(en.tmReasonEnv);
  });

  it('can be turned back on after the setting turned it off', () => {
    const c = controller({ settingEnabled: false, active: false, inactiveReason: 'setting', installId: ID });
    const tree = render(c);
    expect(tree.root.findAll((n) => n.props['data-telemetry-locked'] === true)).toHaveLength(0);
    act(() => toggle(tree).props.onClick());
    expect(c.setEnabled).toHaveBeenCalledWith(true);
  });

  it('is hidden while loading and when the server does not answer', () => {
    expect(render(controller(undefined)).toJSON()).toBeNull();
  });
});
