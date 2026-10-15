import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { en } from '@/i18n/vocab';
import type { NativeUninstallInfo, NativeUninstallStep } from '@/lib/native-bridge';
import { UninstallScreen } from './UninstallScreen';
import type { UninstallPorts } from './uninstall-flow';
vi.mock('@/i18n', () => ({ useVocab: () => en, useLang: () => 'en' }));

const text = (view: ReactTestRenderer) => JSON.stringify(view.toJSON());
const INFO: NativeUninstallInfo = {
  localServer: true, home: '/home/me/.cortex', appData: ['/home/me/.local/share/dev.cortex.desktop'],
  removal: 'installer', appLocation: null, fromInstaller: true,
};

function ports(info: NativeUninstallInfo, steps: NativeUninstallStep[]): UninstallPorts & { [K in keyof UninstallPorts]: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(async () => info), run: vi.fn(async () => steps), exit: vi.fn(async () => null) };
}

async function render(p: UninstallPorts) {
  let view!: ReactTestRenderer;
  await act(async () => { view = create(<UninstallScreen ports={p} />); });
  return view;
}

const byAction = (view: ReactTestRenderer, action: string): ReactTestInstance => view.root.findByProps({ 'data-action': action });

it('removes the server with its data and hands the result back to the installer', async () => {
  const p = ports(INFO, [
    { step: 'autostart', status: 'skipped' }, { step: 'daemon', status: 'done' }, { step: 'runtime', status: 'done' },
    { step: 'data', status: 'done' }, { step: 'app', status: 'deferred' },
  ]);
  const view = await render(p);
  expect(text(view)).toContain(en.uninstScopeServer);
  expect(text(view)).not.toContain('/home/me/.cortex');
  await act(async () => { byAction(view, 'uninstall-delete-data').props.onChange({ target: { checked: true } }); });
  expect(text(view)).toContain('/home/me/.cortex');
  await act(async () => { byAction(view, 'uninstall-confirm').props.onClick(); });
  expect(p.run).toHaveBeenCalledWith('server', true);
  expect(text(view)).toContain(en.uninstInstallerIntro);
  expect(text(view)).not.toContain(en.uninstStepAutostart);
  expect(text(view)).toContain(en.uninstStatusDeferred);
  await act(async () => { byAction(view, 'uninstall-done').props.onClick(); });
  expect(p.exit).toHaveBeenCalledWith(true);
});

it('offers retry after a server step fails, and only the app without a local server', async () => {
  const failing = ports(INFO, [{ step: 'daemon', status: 'failed', detail: 'Local client did not exit.' }]);
  const view = await render(failing);
  await act(async () => { byAction(view, 'uninstall-confirm').props.onClick(); });
  expect(text(view)).toContain(en.uninstFailedTitle);
  expect(text(view)).toContain('Local client did not exit.');
  expect(text(view)).toContain(en.uninstRetry);
  expect(view.root.findAllByProps({ 'data-action': 'uninstall-done' })).toHaveLength(0);

  const remote = ports({ ...INFO, localServer: false, home: null }, [{ step: 'app', status: 'deferred' }]);
  const other = await render(remote);
  expect(text(other)).toContain(en.uninstNoLocalServer);
  expect(other.root.findAllByProps({ type: 'radio' })).toHaveLength(0);
  await act(async () => { byAction(other, 'uninstall-confirm').props.onClick(); });
  expect(remote.run).toHaveBeenCalledWith('app', false);
});
