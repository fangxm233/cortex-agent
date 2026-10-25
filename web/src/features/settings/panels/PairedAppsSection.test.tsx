import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { en } from '@/i18n/vocab';
import type { PairedAppsController } from '@/features/devices/usePairedApps';
import { PairedAppsSectionView } from './PairedAppsSection';
import { MPairedAppsView } from '@/mobile/screens/MPairedApps';
vi.mock('@/i18n', () => ({ useVocab: () => en, useLang: () => 'en' }));

const text = (view: ReactTestRenderer) => JSON.stringify(view.toJSON());

function controller(over: Partial<PairedAppsController> = {}): PairedAppsController {
  return {
    visible: true, pairing: true, creating: false, code: null,
    rows: [
      { id: 'me', name: 'Windows', meta: 'paired Today', current: true },
      { id: 'ph', name: 'Android', meta: 'paired Today', current: false },
    ],
    createCode: vi.fn(), copyCode: vi.fn(), copyLink: vi.fn(), revoke: vi.fn(),
    ...over,
  };
}

const VIEWS = [['desktop', PairedAppsSectionView], ['mobile', MPairedAppsView]] as const;

it.each(VIEWS)('%s: lists apps, offers revoke only for other devices, and mints a code', async (_name, View) => {
  const c = controller();
  let view!: ReactTestRenderer;
  await act(async () => { view = create(<View controller={c} />); });
  expect(text(view)).toContain(en.pairThisDevice);
  const revokes = view.root.findAll((node) => node.children.includes(en.pairRevoke) && typeof node.props.onClick === 'function');
  expect(revokes).toHaveLength(1);
  await act(async () => revokes[0].props.onClick());
  expect(c.revoke).toHaveBeenCalledWith(c.rows[1]);
  await act(async () => view.root.findAllByProps({ 'data-pairing-create': '' })[0].props.onClick());
  expect(c.createCode).toHaveBeenCalled();
});

it.each(VIEWS)('%s: shows an active code with its copy actions', async (_name, View) => {
  const code = { code: 'ABCD-EFGH', expires: 'expires in 9:59', hint: 'hint', link: 'https://h/#pair=ABCD-EFGH' };
  let view!: ReactTestRenderer;
  await act(async () => { view = create(<View controller={controller({ code, rows: [] })} />); });
  expect(text(view)).toContain('ABCD-EFGH');
  expect(text(view)).toContain(en.pairCopyLink);
  expect(text(view)).not.toContain(en.pairEmpty);
});

it.each(VIEWS)('%s: hides itself when the server has no pairing, and says so when empty', async (_name, View) => {
  let view!: ReactTestRenderer;
  await act(async () => { view = create(<View controller={controller({ visible: false })} />); });
  expect(view.toJSON()).toBeNull();
  await act(async () => { view = create(<View controller={controller({ rows: [], pairing: false })} />); });
  expect(text(view)).toContain(en.pairEmpty);
  expect(view.root.findAllByProps({ 'data-pairing-create': '' })).toHaveLength(0);
});
