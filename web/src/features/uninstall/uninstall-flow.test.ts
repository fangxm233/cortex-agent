import { describe, expect, it } from 'vitest';
import type { NativeUninstallInfo } from '@/lib/native-bridge';
import { dataHint, dataPaths, defaultScope, manualLocation, resultIntro, runResult, shownSteps } from './uninstall-flow';

const info = (over: Partial<NativeUninstallInfo> = {}): NativeUninstallInfo => ({
  localServer: true, home: '/home/me/.cortex', appData: ['/home/me/.local/share/dev.cortex.desktop'],
  removal: 'file', appLocation: '/home/me/Cortex.AppImage', fromInstaller: false, ...over,
});

describe('uninstall flow', () => {
  it('defaults to removing the server only when one is installed here', () => {
    expect(defaultScope(info())).toBe('server');
    expect(defaultScope(info({ localServer: false, home: null }))).toBe('app');
  });

  it('deletes the server home only together with the server', () => {
    expect(dataPaths(info(), 'server')).toEqual(['/home/me/.cortex', '/home/me/.local/share/dev.cortex.desktop']);
    expect(dataPaths(info(), 'app')).toEqual(['/home/me/.local/share/dev.cortex.desktop']);
    expect(dataHint(info(), 'server', true)).toBe('uninstDeleteServerDataHint');
    expect(dataHint(info(), 'app', true)).toBe('uninstDeleteAppDataHint');
    expect(dataHint(info(), 'server', false)).toBe('uninstKeepDataHint');
  });

  it('tells a failed server step from an app the user has to delete', () => {
    expect(runResult([{ step: 'daemon', status: 'done' }, { step: 'app', status: 'done' }])).toBe('done');
    expect(runResult([{ step: 'daemon', status: 'failed', detail: 'x' }])).toBe('failed');
    expect(runResult([{ step: 'runtime', status: 'done' }, { step: 'app', status: 'failed' }])).toBe('app-failed');
    expect(resultIntro(info(), 'app-failed')).toBe('uninstAppFailedIntro');
    expect(manualLocation(info(), 'app-failed')).toBe('/home/me/Cortex.AppImage');
  });

  it('words the finish by how the app is removed', () => {
    expect(resultIntro(info({ removal: 'installer' }), 'done')).toBe('uninstInstallerIntro');
    expect(resultIntro(info({ removal: 'trash' }), 'done')).toBe('uninstTrashIntro');
    expect(resultIntro(info({ removal: 'manual', appLocation: '/opt/cortex' }), 'done')).toBe('uninstManualIntro');
    expect(manualLocation(info({ removal: 'manual', appLocation: '/opt/cortex' }), 'done')).toBe('/opt/cortex');
    expect(manualLocation(info(), 'done')).toBeNull();
  });

  it('hides steps that had nothing to do', () => {
    expect(shownSteps([{ step: 'autostart', status: 'skipped' }, { step: 'app', status: 'deferred' }]))
      .toEqual([{ step: 'app', status: 'deferred' }]);
  });
});
