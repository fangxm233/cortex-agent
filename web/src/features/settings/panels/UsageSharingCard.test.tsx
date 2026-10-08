import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { UsageSharingSettings } from '@cortex-agent/ui-contract';
import { en } from '@/i18n/vocab';
import { UsageSharingCard, type UsageSharingVariant } from './UsageSharingCard';
import { UsageSharingController } from '@/features/settings/vm/usage-sharing-vm';

vi.mock('@/i18n', async importOriginal => ({ ...await importOriginal<typeof import('@/i18n')>(), useVocab: () => en }));

const OFF: UsageSharingSettings = { enabled: false, name: '', org: '', email: '' };

async function mount(variant: UsageSharingVariant = 'settings', get = vi.fn().mockResolvedValue(OFF)) {
  const set = vi.fn(async (input: UsageSharingSettings) => input);
  const controller = new UsageSharingController({ get, set });
  let view!: ReactTestRenderer;
  await act(async () => { view = create(<UsageSharingCard controller={controller} variant={variant} />); await controller.load(); });
  return { view, set };
}

const field = (view: ReactTestRenderer, name: string) => view.root.findByProps({ 'data-usage-sharing-field': name });
const saveButtons = (view: ReactTestRenderer) => view.root.findAll(node => node.type === 'button' && node.props['data-usage-sharing-save']);
const text = (view: ReactTestRenderer) => JSON.stringify(view.toJSON());

function type(view: ReactTestRenderer, name: string, value: string) {
  act(() => field(view, name).props.onChange({ target: { value } }));
}

it('shows the identity fields and Save only once sharing is switched on', async () => {
  const { view } = await mount();
  expect(view.root.findAllByProps({ 'data-usage-sharing-field': 'name' })).toHaveLength(0);
  expect(saveButtons(view)).toHaveLength(0);
  expect(view.root.findByProps({ href: 'https://aistatus.cc/leaderboard' })).toBeTruthy();

  act(() => view.root.findByProps({ role: 'switch' }).props.onClick());

  expect(field(view, 'name')).toBeTruthy();
  expect(field(view, 'org')).toBeTruthy();
  expect(field(view, 'email')).toBeTruthy();
  expect(saveButtons(view)).toHaveLength(1);
});

it('marks missing fields inline instead of saving', async () => {
  const { view, set } = await mount();
  act(() => view.root.findByProps({ role: 'switch' }).props.onClick());

  await act(async () => saveButtons(view)[0].props.onClick());

  expect(set).not.toHaveBeenCalled();
  expect(field(view, 'name').props['aria-invalid']).toBe(true);
  expect(field(view, 'email').props['aria-invalid']).toBe(true);
  expect(text(view)).toContain(en.usageShareNameRequired);
  expect(text(view)).toContain(en.usageShareEmailInvalid);
});

it('saves the identity and reports success', async () => {
  const { view, set } = await mount();
  act(() => view.root.findByProps({ role: 'switch' }).props.onClick());
  type(view, 'name', 'Ada');
  type(view, 'email', 'ada@example.com');

  await act(async () => saveButtons(view)[0].props.onClick());

  expect(set).toHaveBeenCalledWith({ enabled: true, name: 'Ada', org: '', email: 'ada@example.com' });
  expect(view.root.findByProps({ role: 'status' }).children.join('')).toBe(en.usageShareSaved);
  expect(saveButtons(view)).toHaveLength(0);
});

it('reports a failed save and keeps the draft', async () => {
  const { view, set } = await mount();
  set.mockRejectedValueOnce(new Error('disk full'));
  act(() => view.root.findByProps({ role: 'switch' }).props.onClick());
  type(view, 'name', 'Ada');
  type(view, 'email', 'ada@example.com');

  await act(async () => saveButtons(view)[0].props.onClick());

  expect(text(view)).toContain('disk full');
  expect(field(view, 'name').props.value).toBe('Ada');
  expect(saveButtons(view)).toHaveLength(1);
});

it('reports a load failure in Settings but stays hidden on the setup page', async () => {
  const failing = () => vi.fn().mockRejectedValue(new Error('offline'));
  const settings = await mount('settings', failing());
  const setup = await mount('setup', failing());

  expect(text(settings.view)).toContain(en.usageShareLoadFailed);
  expect(setup.view.toJSON()).toBeNull();
});
