import { describe, expect, it, vi } from 'vitest';
import { en, zh } from '@/i18n/vocab';
import type { NativeSetupAnswers, NativeSetupProbe } from '@/lib/native-bridge';
import { LocalSetupFlow, localSetupErrorText, setupLogLine, type LocalSetupPorts } from './local-setup';

const answers: NativeSetupAnswers = { lang: 'en', machineName: 'test-machine', backends: ['pi'], port: 13004, installService: false };
const probe: NativeSetupProbe = {
  node: 'v22.19.0', nodeOk: true, npm: '10', git: 'git version 2', cortexBin: null, serverVersion: null,
  serverOk: false, homeExists: false, hostname: 'host', os: 'linux',
};
const endpoint = { url: 'http://127.0.0.1:13004', token: 'fixture-token' };

function fixture(overrides: Partial<LocalSetupPorts> = {}, ready: Promise<unknown> = Promise.resolve()) {
  const calls: string[] = [];
  const ports: LocalSetupPorts = {
    probe: async () => ({ ...probe }),
    installServer: async () => ({ cortexBin: '/isolated/bin/cortex', serverVersion: '2026.9.7' }),
    cancelInstall: async () => undefined,
    runInit: async () => ({ version: null, uiUrl: endpoint.url, clientToken: endpoint.token }),
    enableUi: async () => endpoint,
    startDaemon: async () => true,
    enableAutostart: async () => true,
    connect: async () => undefined,
    ...overrides,
  };
  const recorded = Object.fromEntries(Object.entries(ports).map(([name, port]) =>
    [name, (...args: unknown[]) => { calls.push(name); return (port as (...a: unknown[]) => unknown)(...args); }]));
  return { flow: new LocalSetupFlow(recorded as unknown as LocalSetupPorts, ready), calls };
}

describe('local setup flow', () => {
  it.each(['macos', 'linux'])('automatically installs and initializes %s with defaults through provider setup', async os => {
    const runInit = vi.fn(async () => ({ version: null, uiUrl: endpoint.url, clientToken: endpoint.token }));
    const { flow, calls } = fixture({
      probe: async () => ({ ...probe, os, node: null, nodeOk: false, npm: null, git: null }), runInit,
    });
    const stages: string[] = [];
    flow.subscribe(() => stages.push(flow.state.stage));
    await flow.prepare('zh');
    expect(runInit).toHaveBeenCalledWith('/isolated/bin/cortex', {
      lang: 'zh', machineName: 'host', port: 3004, installService: false, backends: ['pi'],
    });
    expect(calls).toEqual(['probe', 'installServer', 'runInit', 'startDaemon', 'connect']);
    expect(stages).not.toContain('configure');
    expect(flow.state).toMatchObject({ stage: 'ready', destination: 'index.html#/setup/providers' });
  });

  it('automatically starts an existing configuration without init, service changes or a port override', async () => {
    const enableUi = vi.fn(async () => endpoint);
    const { flow, calls } = fixture({ probe: async () => ({ ...probe, homeExists: true }), enableUi });
    await flow.prepare('en');
    expect(enableUi).toHaveBeenCalledWith('/isolated/bin/cortex', undefined);
    expect(calls).toEqual(['probe', 'installServer', 'enableUi', 'startDaemon', 'connect']);
    expect(flow.state).toMatchObject({ stage: 'ready', destination: 'index.html' });
  });

  it('retries initialization with the original automatic defaults', async () => {
    const runInit = vi.fn().mockRejectedValueOnce(new Error('INIT_FAILED'))
      .mockResolvedValue({ uiUrl: endpoint.url, clientToken: endpoint.token });
    const { flow } = fixture({ runInit });
    await flow.prepare('zh');
    expect(flow.state).toMatchObject({ stage: 'start', error: 'INIT_FAILED' });
    const original = flow.state.answers!;
    await flow.start(original);
    expect(runInit.mock.calls.map(call => call[1])).toEqual([original, original]);
    expect(original).toMatchObject({ lang: 'zh', machineName: 'host', port: 3004, installService: false });
    expect(flow.state.destination).toBe('index.html#/setup/providers');
  });

  it('keeps the configured endpoint on automatic retry but sends an explicit repair port', async () => {
    const enableUi = vi.fn().mockRejectedValueOnce(new Error('UI_ENABLE_FAILED')).mockResolvedValue(endpoint);
    const { flow, calls } = fixture({ probe: async () => ({ ...probe, homeExists: true }), enableUi,
      startDaemon: async () => false });
    await flow.prepare('en');
    await flow.start(flow.state.answers!);
    expect(enableUi.mock.calls.map(call => call[1])).toEqual([undefined, undefined]);
    flow.configure();
    expect(flow.state.stage).toBe('configure');
    await flow.start({ ...answers, port: 14004 });
    expect(enableUi).toHaveBeenLastCalledWith('/isolated/bin/cortex', 14004);
    expect(calls).not.toContain('runInit');
    expect(calls).not.toContain('enableAutostart');
  });

  it('does not expose repair settings without a start failure', async () => {
    const { flow } = fixture({ installServer: async () => { throw new Error('SERVER_INSTALL_FAILED'); } });
    await flow.prepare('en');
    flow.configure();
    expect(flow.state.stage).toBe('prepare');
  });

  it('keeps Windows prerequisite checks and manual configuration with automatic entry', async () => {
    const probeWindows = vi.fn().mockResolvedValueOnce({ ...probe, os: 'windows', nodeOk: false })
      .mockResolvedValue({ ...probe, os: 'windows' });
    const { flow, calls } = fixture({ probe: probeWindows });
    await flow.prepare('en');
    expect(flow.state.error).toBe('NODE_REQUIRED');
    await flow.prepare('en');
    expect(flow.state.stage).toBe('configure');
    expect(calls).toEqual(['probe', 'probe', 'installServer']);
  });

  it('checks, installs and opens configuration', async () => {
    const { flow, calls } = fixture();
    await flow.prepare();
    expect(calls).toEqual(['probe', 'installServer']);
    expect(flow.state).toMatchObject({ stage: 'configure', busy: false, bin: '/isolated/bin/cortex', version: '2026.9.7' });
  });

  it('initializes, starts and connects on submit, then hands a new install to provider setup', async () => {
    const connected: unknown[] = [];
    const { flow, calls } = fixture({ connect: async (...args) => { connected.push(args); } });
    await flow.prepare();
    await flow.start(answers);
    expect(calls.slice(2)).toEqual(['runInit', 'startDaemon', 'connect']);
    expect(connected).toEqual([[endpoint, '/isolated/bin/cortex']]);
    expect(flow.state.stage).toBe('ready');
    expect(flow.state.destination).toBe('index.html#/setup/providers');
  });

  it.each(['macos', 'linux'])('ensures an existing %s install on each preparation and keeps its configuration', async os => {
    const { flow, calls } = fixture({
      probe: async () => ({ ...probe, os, serverOk: true, homeExists: true, cortexBin: '/existing/cortex' }),
      installServer: async () => ({ cortexBin: '/existing/cortex', serverVersion: '2026.9.7' }),
    });
    await flow.prepare();
    await flow.prepare();
    await flow.start(answers);
    expect(calls).toEqual(['probe', 'installServer', 'probe', 'installServer', 'enableUi', 'startDaemon', 'connect']);
    expect(flow.state).toMatchObject({ destination: 'index.html', bin: '/existing/cortex', newInstall: false });
  });

  it('stops on Windows when Node is missing, and can recheck', async () => {
    let valid = false;
    const { flow, calls } = fixture({ probe: async () => ({ ...probe, os: 'windows', nodeOk: valid }) });
    await flow.prepare();
    expect(flow.state.error).toBe('NODE_REQUIRED');
    expect(flow.state.progress.check).toBe('error');
    expect(calls).toEqual(['probe']);
    valid = true;
    await flow.prepare();
    expect(flow.state.stage).toBe('configure');
  });

  it.each([['npm', 'NPM_REQUIRED']] as const)('reports missing %s', async (field, error) => {
    const { flow, calls } = fixture({ probe: async () => ({ ...probe, os: 'windows', [field]: null }) });
    await flow.prepare();
    expect(flow.state.error).toBe(error);
    expect(calls).toEqual(['probe']);
  });

  it.each(['macos', 'linux'])('reaches provider setup without Node, npm or Git on %s', async os => {
    const { flow, calls } = fixture({ probe: async () => ({ ...probe, os, node: null, nodeOk: false, npm: null, git: null }) });
    await flow.prepare();
    await flow.start(answers);
    expect(calls).toEqual(['probe', 'installServer', 'runInit', 'startDaemon', 'connect']);
    expect(flow.state).toMatchObject({ error: null, stage: 'ready', destination: 'index.html#/setup/providers' });
  });

  it('keeps the Git prerequisite on Windows', async () => {
    const { flow, calls } = fixture({ probe: async () => ({ ...probe, os: 'windows', git: null }) });
    await flow.prepare();
    expect(flow.state.error).toBe('GIT_REQUIRED');
    expect(calls).toEqual(['probe']);
  });

  it('reuses a supported Windows server without invoking installation', async () => {
    const { flow, calls } = fixture({ probe: async () => ({ ...probe, os: 'windows', serverOk: true, cortexBin: '/existing/cortex' }) });
    await flow.prepare();
    expect(calls).toEqual(['probe']);
    expect(flow.state.bin).toBe('/existing/cortex');
  });

  it.each(['RUNTIME_DOWNLOAD_FAILED', 'RUNTIME_INTEGRITY_FAILED', 'RUNTIME_UNSUPPORTED',
    'RUNTIME_MISSING', 'SERVER_EXTERNAL_UNSUPPORTED', 'SETUP_CANCELLED'])('can retry %s without connecting early', async code => {
    let succeeds = false;
    const { flow, calls } = fixture({ installServer: async () => {
      if (!succeeds) throw new Error(`${code}: internal detail`);
      return { cortexBin: '/isolated/bin/cortex', serverVersion: null };
    } });
    await flow.prepare();
    expect(flow.state).toMatchObject({ stage: 'prepare', busy: false, destination: null, error: `${code}: internal detail` });
    await flow.start(answers);
    expect(calls).toEqual(['probe', 'installServer']);
    succeeds = true;
    await flow.prepare();
    await flow.start(answers);
    expect(calls.filter(name => name === 'installServer')).toHaveLength(2);
    expect(flow.state).toMatchObject({ stage: 'ready', error: null, destination: 'index.html#/setup/providers' });
  });

  it('retries the daemon without rewriting a successful initialization', async () => {
    let succeeds = false;
    const { flow, calls } = fixture({ startDaemon: async () => succeeds });
    await flow.prepare();
    await flow.start(answers);
    expect(flow.state).toMatchObject({ error: 'DAEMON_TIMEOUT', destination: null, needsInit: false });
    expect(flow.state.progress.daemon).toBe('error');
    succeeds = true;
    await flow.start(answers);
    expect(calls.filter(name => name === 'runInit')).toHaveLength(1);
    expect(flow.state.destination).toBe('index.html#/setup/providers');
  });

  it('keeps the new-install identity when settings are edited after init', async () => {
    let succeeds = false;
    const { flow, calls } = fixture({ startDaemon: async () => succeeds });
    await flow.prepare();
    await flow.start(answers);
    flow.configure();
    expect(flow.state.stage).toBe('configure');
    succeeds = true;
    await flow.start(answers);
    expect(calls.filter(name => name === 'runInit')).toHaveLength(1);
    expect(calls).toContain('enableUi');
    expect(flow.state.destination).toBe('index.html#/setup/providers');
  });

  it('never hands off before connecting, and retry keeps the initialization', async () => {
    let succeeds = false;
    const { flow, calls } = fixture({ connect: async () => { if (!succeeds) throw 'connect failed'; } });
    await flow.prepare();
    await flow.start(answers);
    expect(flow.state).toMatchObject({ stage: 'start', destination: null, error: 'connect failed' });
    succeeds = true;
    await flow.start(answers);
    expect(calls.filter(name => name === 'runInit')).toHaveLength(1);
    expect(flow.state.destination).toBe('index.html#/setup/providers');
  });

  it('cancels only an active preparation install and waits for native settlement', async () => {
    let reject!: (error: Error) => void;
    const install = new Promise<never>((_, fail) => { reject = fail; });
    const { flow, calls } = fixture({ installServer: () => install });
    await flow.cancelInstall();
    const preparing = flow.prepare();
    await Promise.resolve();
    await flow.cancelInstall(); // Still probing.
    await Promise.resolve();
    expect(flow.state.active).toBe('install');
    await flow.cancelInstall();
    expect(calls).toEqual(['probe', 'installServer', 'cancelInstall']);
    expect(flow.state).toMatchObject({ stage: 'prepare', busy: true, destination: null });
    reject(new Error('SETUP_CANCELLED'));
    await preparing;
    expect(flow.state).toMatchObject({ stage: 'prepare', busy: false, error: 'SETUP_CANCELLED' });
    await flow.cancelInstall();
    expect(calls.filter(name => name === 'cancelInstall')).toHaveLength(1);
  });

  it('does not allow retry while a cancellation acknowledgement is pending', async () => {
    let reject!: (error: Error) => void;
    let acknowledge!: () => void;
    const install = new Promise<never>((_, fail) => { reject = fail; });
    const cancel = new Promise<void>(resolve => { acknowledge = resolve; });
    const { flow, calls } = fixture({ installServer: () => install, cancelInstall: () => cancel });
    const preparing = flow.prepare();
    await Promise.resolve();
    await Promise.resolve();
    const cancelling = flow.cancelInstall();
    await flow.cancelInstall();
    reject(new Error('SETUP_CANCELLED'));
    await preparing;
    await flow.prepare();
    expect(calls).toEqual(['probe', 'installServer', 'cancelInstall']);
    expect(flow.state.cancelling).toBe(true);
    acknowledge();
    await cancelling;
    expect(flow.state).toMatchObject({ cancelling: false, stage: 'prepare', destination: null });
  });

  it('does not cancel configuration, startup or an existing daemon', async () => {
    let finish!: (ready: boolean) => void;
    const daemon = new Promise<boolean>(resolve => { finish = resolve; });
    const { flow, calls } = fixture({ startDaemon: () => daemon });
    await flow.prepare();
    await flow.cancelInstall();
    const starting = flow.start(answers);
    await Promise.resolve();
    await flow.cancelInstall();
    finish(true);
    await starting;
    await flow.cancelInstall();
    expect(calls).not.toContain('cancelInstall');
    expect(flow.state.stage).toBe('ready');
  });

  it('waits for the log listener and ignores a second click while busy', async () => {
    let release!: () => void;
    const { flow, calls } = fixture({}, new Promise<void>(resolve => { release = resolve; }));
    const first = flow.prepare();
    await flow.prepare();
    expect(flow.state.busy).toBe(true);
    expect(calls).toEqual([]);
    release();
    await first;
    expect(calls).toEqual(['probe', 'installServer']);
  });

  it('does not treat a failed install as configured', async () => {
    const { flow } = fixture({ installServer: async () => { throw new Error('SERVER_INSTALL_FAILED: npm ERR'); } });
    await flow.prepare();
    expect(flow.state).toMatchObject({ stage: 'prepare', error: 'SERVER_INSTALL_FAILED: npm ERR', busy: false });
  });

  it('opens the workspace even when auto-start fails', async () => {
    const { flow } = fixture({ enableAutostart: async () => { throw new Error('no service'); } });
    await flow.prepare();
    await flow.start({ ...answers, installService: true });
    expect(flow.state).toMatchObject({ stage: 'ready', warning: 'AUTOSTART_FAILED' });
    expect(flow.state.progress.autostart).toBe('warning');
  });
});

describe('local setup copy', () => {
  it('shows translated actions without raw technical output', () => {
    expect(localSetupErrorText('SERVER_INSTALL_FAILED: npm ERR! 404', en)).toBe(en.onbErrServerInstallFailed);
    expect(localSetupErrorText('NODE_REQUIRED', zh)).toBe(zh.onbErrNodeRequired);
    expect(localSetupErrorText('something else', en)).toBe(en.onbErrSetupTaskFailed);
  });

  it.each([
    ['RUNTIME_DOWNLOAD_FAILED', 'onbErrRuntimeDownloadFailed'],
    ['RUNTIME_INTEGRITY_FAILED', 'onbErrRuntimeIntegrityFailed'],
    ['RUNTIME_UNSUPPORTED', 'onbErrRuntimeUnsupported'],
    ['RUNTIME_MISSING', 'onbErrRuntimeMissing'],
    ['SERVER_EXTERNAL_UNSUPPORTED', 'onbErrServerExternalUnsupported'],
    ['SETUP_CANCELLED', 'onbErrSetupCancelled'],
  ] as const)('translates %s without exposing details', (code, key) => {
    for (const vocab of [en, zh]) {
      expect(localSetupErrorText(`${code}: Node /private/runtime checksum`, vocab)).toBe(vocab[key]);
    }
  });

  it('shows only the install and start runs of the log, without colour codes', () => {
    expect(setupLogLine({ run: 'install', line: '\x1b[32madded 1 package\x1b[0m' })).toBe('added 1 package');
    expect(setupLogLine({ run: 'claude-install', line: 'x' })).toBeNull();
    expect(setupLogLine(null)).toBeNull();
  });
});
