import { describe, expect, it } from 'vitest';
import { en, zh } from '@/i18n/vocab';
import type { NativeSetupAnswers, NativeSetupProbe } from '@/lib/native-bridge';
import { LocalSetupFlow, localSetupErrorText, setupLogLine, type LocalSetupPorts } from './local-setup';

const answers: NativeSetupAnswers = { lang: 'en', machineName: 'test-machine', backends: ['pi'], port: 13004, installService: false };
const probe: NativeSetupProbe = {
  node: 'v22.0.0', nodeOk: true, npm: '10', git: 'git version 2', cortexBin: null, serverVersion: null,
  serverOk: false, homeExists: false, hostname: 'host', os: 'linux',
};
const endpoint = { url: 'http://127.0.0.1:13004', token: 'fixture-token' };

function fixture(overrides: Partial<LocalSetupPorts> = {}, ready: Promise<unknown> = Promise.resolve()) {
  const calls: string[] = [];
  const ports: LocalSetupPorts = {
    probe: async () => ({ ...probe }),
    installServer: async () => ({ cortexBin: '/isolated/bin/cortex', serverVersion: '2026.9.7' }),
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

  it('skips npm for a supported install and keeps its configuration', async () => {
    const { flow, calls } = fixture({ probe: async () => ({ ...probe, serverOk: true, homeExists: true, cortexBin: '/existing/cortex' }) });
    await flow.prepare();
    await flow.start(answers);
    expect(calls).toEqual(['probe', 'enableUi', 'startDaemon', 'connect']);
    expect(flow.state.destination).toBe('index.html');
  });

  it('stops before installing when a prerequisite is missing, and can recheck', async () => {
    let valid = false;
    const { flow, calls } = fixture({ probe: async () => ({ ...probe, nodeOk: valid }) });
    await flow.prepare();
    expect(flow.state.error).toBe('NODE_REQUIRED');
    expect(flow.state.progress.check).toBe('error');
    expect(calls).toEqual(['probe']);
    valid = true;
    await flow.prepare();
    expect(flow.state.stage).toBe('configure');
  });

  it.each([['npm', 'NPM_REQUIRED']] as const)('reports missing %s', async (field, error) => {
    const { flow, calls } = fixture({ probe: async () => ({ ...probe, [field]: null }) });
    await flow.prepare();
    expect(flow.state.error).toBe(error);
    expect(calls).toEqual(['probe']);
  });

  it.each(['macos', 'linux'])('reaches provider setup without Git on %s', async os => {
    const { flow, calls } = fixture({ probe: async () => ({ ...probe, os, git: null }) });
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
  it('words known codes in the UI language and keeps the process output under them', () => {
    expect(localSetupErrorText('SERVER_INSTALL_FAILED: npm ERR! 404', en)).toBe(`${en.onbErrServerInstallFailed}\n\nnpm ERR! 404`);
    expect(localSetupErrorText('NODE_REQUIRED', zh)).toBe(zh.onbErrNodeRequired);
    expect(localSetupErrorText('something else', en)).toBe('something else');
  });

  it('shows only the install and start runs of the log, without colour codes', () => {
    expect(setupLogLine({ run: 'install', line: '\x1b[32madded 1 package\x1b[0m' })).toBe('added 1 package');
    expect(setupLogLine({ run: 'claude-install', line: 'x' })).toBeNull();
    expect(setupLogLine(null)).toBeNull();
  });
});
