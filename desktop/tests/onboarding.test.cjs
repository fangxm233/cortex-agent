// input:  standalone setup controller and native command fixtures
// output: PI-only setup, provider handoff and retry contract tests
// pos:    Focused native onboarding behavior checks
// >>> Once updated, update this header and the parent CORTEX.md <<<
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const ui = join(__dirname, '../ui');
const source = readFileSync(join(ui, 'setup-flow.js'), 'utf8');
const answers = { machineName: 'test-machine', backends: ['pi'], port: 13004, installService: false };
const probe = { node: 'v22.0.0', nodeOk: true, npm: '10', git: 'git version 2',
  serverOk: false, cortexBin: null, serverVersion: null, homeExists: false };
function fixture(overrides = {}, ready = Promise.resolve()) {
  const calls = [], states = [], context = {};
  runInNewContext(source, context);
  const defaults = {
    setup_probe: () => ({ ...probe }),
    setup_install_server: () => ({ cortexBin: '/isolated/bin/cortex', serverVersion: '2026.9.7' }),
    setup_run_init: () => ({ uiUrl: 'http://127.0.0.1:13004', clientToken: 'fixture-token' }),
    setup_enable_ui: () => ({ url: 'http://127.0.0.1:13004', token: 'fixture-token' }),
    setup_start_daemon: () => true, connect: () => undefined,
  };
  const invoke = async (name, args) => {
    calls.push(name);
    return (overrides[name] || defaults[name])(args);
  };
  const controller = context.CortexSetupFlow(invoke, (state) => states.push(state.stage), ready);
  return { controller, calls, states };
}
test('install entry automatically checks, installs and opens configuration', async () => {
  const { controller, calls } = fixture();
  await controller.prepare();
  assert.deepEqual(calls, ['setup_probe', 'setup_install_server']);
  assert.equal(controller.state.stage, 'configure');
  assert.equal(controller.state.busy, false);
});
test('configuration submit initializes, starts and connects without another confirmation', async () => {
  const { controller, calls } = fixture();
  await controller.prepare();
  await controller.start(answers);
  assert.deepEqual(calls.slice(2), ['setup_run_init', 'setup_start_daemon', 'connect']);
  assert.equal(controller.state.stage, 'ready');
  assert.equal(controller.state.destination, 'index.html#/setup/providers');
});
test('supported install skips npm and preserves existing configuration', async () => {
  const { controller, calls } = fixture({ setup_probe: () => ({ ...probe, serverOk: true, homeExists: true, cortexBin: '/existing/cortex' }) });
  await controller.prepare();
  await controller.start(answers);
  assert.deepEqual(calls, ['setup_probe', 'setup_enable_ui', 'setup_start_daemon', 'connect']);
  assert.equal(controller.state.destination, 'index.html');
});
test('missing prerequisites stop before installation and can be rechecked', async () => {
  let valid = false;
  const { controller, calls } = fixture({ setup_probe: () => ({ ...probe, nodeOk: valid }) });
  await controller.prepare();
  assert.equal(controller.state.error, 'NODE_REQUIRED');
  assert.deepEqual(calls, ['setup_probe']);
  valid = true;
  await controller.prepare();
  assert.equal(controller.state.stage, 'configure');
});
test('missing npm or git produces an actionable prerequisite failure', async () => {
  for (const [field, error] of [['npm', 'NPM_REQUIRED'], ['git', 'GIT_REQUIRED']]) {
    const { controller, calls } = fixture({ setup_probe: () => ({ ...probe, [field]: null }) });
    await controller.prepare();
    assert.equal(controller.state.error, error);
    assert.deepEqual(calls, ['setup_probe']);
  }
});
test('daemon retry reuses successful initialization instead of rewriting it', async () => {
  let succeeds = false;
  const { controller, calls } = fixture({ setup_start_daemon: () => succeeds });
  await controller.prepare();
  await controller.start(answers);
  assert.equal(controller.state.error, 'DAEMON_TIMEOUT');
  assert.equal(controller.state.destination, null);
  assert.equal(controller.state.needsInit, false);
  assert.equal(controller.state.progress.daemon, 'error');
  succeeds = true;
  await controller.start(answers);
  assert.equal(calls.filter((name) => name === 'setup_run_init').length, 1);
  assert.equal(controller.state.stage, 'ready');
  assert.equal(controller.state.destination, 'index.html#/setup/providers');
});
test('new-install identity survives editing settings after successful init', async () => {
  let succeeds = false;
  const { controller, calls } = fixture({ setup_start_daemon: () => succeeds });
  await controller.prepare();
  await controller.start(answers);
  controller.configure();
  succeeds = true;
  await controller.start(answers);
  assert.equal(calls.filter((name) => name === 'setup_run_init').length, 1);
  assert.ok(calls.includes('setup_enable_ui'));
  assert.equal(controller.state.destination, 'index.html#/setup/providers');
});
test('connection failure never hands off early and retry preserves initialization', async () => {
  let succeeds = false;
  const { controller, calls } = fixture({ connect: () => { if (!succeeds) throw new Error('connect failed'); } });
  await controller.prepare();
  await controller.start(answers);
  assert.equal(controller.state.destination, null);
  assert.equal(controller.state.stage, 'start');
  succeeds = true;
  await controller.start(answers);
  assert.equal(calls.filter((name) => name === 'setup_run_init').length, 1);
  assert.equal(controller.state.destination, 'index.html#/setup/providers');
});
test('double clicks cannot start parallel installs and progress listener is awaited', async () => {
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  const { controller, calls } = fixture({}, ready);
  const first = controller.prepare();
  await controller.prepare();
  assert.equal(controller.state.busy, true);
  assert.deepEqual(calls, []);
  release();
  await first;
  assert.deepEqual(calls, ['setup_probe', 'setup_install_server']);
});
test('install failure is not treated as configured and retry remains available', async () => {
  const { controller } = fixture({ setup_install_server: () => { throw new Error('old package'); } });
  await controller.prepare();
  assert.equal(controller.state.stage, 'prepare');
  assert.equal(controller.state.error, 'old package');
  assert.equal(controller.state.busy, false);
});
test('autostart failure does not block a usable workspace', async () => {
  const { controller } = fixture({ setup_enable_autostart: () => { throw new Error('no service'); } });
  await controller.prepare();
  await controller.start({ ...answers, installService: true });
  assert.equal(controller.state.stage, 'ready');
  assert.equal(controller.state.warning, 'AUTOSTART_FAILED');
});
test('setup markup has one submit action and all native assets are embedded', () => {
  const html = readFileSync(join(ui, 'setup.html'), 'utf8');
  assert.equal((html.match(/type="submit"/g) || []).length, 1);
  assert.ok(!html.includes('cx-btn-next'));
  assert.ok(!html.includes('cx-backend-'));
  const presenter = readFileSync(join(ui, 'setup.js'), 'utf8');
  assert.match(presenter, /backends: \['pi'\]/);
  assert.ok(!presenter.includes('cx-backend-'));
  assert.match(presenter, /window.location.href = state.destination/);
  const resolver = readFileSync(join(__dirname, '../src-tauri/src/frontend.rs'), 'utf8');
  for (const page of ['setup.html', 'connect.html']) {
    const source = readFileSync(join(ui, page), 'utf8');
    const assets = [...source.matchAll(/(?:src|href)="((?:shell|connect|setup)[\w.-]*\.(?:js|css))"/g)];
    for (const [, asset] of assets) assert.ok(resolver.includes(`../../ui/${asset}`), asset);
  }
});
test('all onboarding colors use defined shared tokens', () => {
  const css = readFileSync(join(ui, 'shell.css'), 'utf8');
  const theme = readFileSync(join(__dirname, '../../web/public/theme.css'), 'utf8');
  for (const [, token] of css.matchAll(/var\((--[\w-]+)\)/g)) assert.ok(theme.includes(token + ':'), token);
});
