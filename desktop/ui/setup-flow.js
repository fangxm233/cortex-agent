// input:  native setup commands, progress subscriber
// output: CortexSetupFlow with new-install provider handoff
// pos:    Framework-free state transitions for native onboarding
// >>> Once updated, update this header and the parent CORTEX.md <<<
(function (root) {
  'use strict';
  function createFlow(invoke, notify, ready) {
    var state = { stage: 'prepare', busy: false, error: null, active: null,
      probe: null, bin: null, version: null, needsInit: true, endpoint: null,
      progress: {}, warning: null, newInstall: null, destination: null };
    function publish() { notify(state); }
    function mark(key, value) {
      state.progress[key] = value;
      state.active = key;
      publish();
    }
    async function operation(action) {
      if (state.busy) return;
      state.busy = true;
      state.error = null;
      publish();
      try {
        await ready;
        await action();
      } catch (error) {
        state.error = String(error && error.message || error);
        state.progress[state.active] = 'error';
      } finally {
        state.busy = false;
        publish();
      }
    }
    function acceptProbe(probe) {
      state.probe = probe;
      state.bin = probe.cortexBin;
      state.version = probe.serverVersion;
      state.needsInit = !probe.homeExists;
      // Keep the entry identity even after init creates config or a retry re-probes.
      if (state.newInstall === null) state.newInstall = state.needsInit;
      if (!probe.nodeOk) throw new Error('NODE_REQUIRED');
      if (!probe.npm) throw new Error('NPM_REQUIRED');
      if (!probe.git) throw new Error('GIT_REQUIRED');
    }
    async function prepare() {
      return operation(async function () {
        state.stage = 'prepare';
        state.progress = {};
        mark('check', 'running');
        acceptProbe(await invoke('setup_probe'));
        mark('check', 'done');
        await install();
        state.stage = 'configure';
      });
    }
    async function install() {
      if (state.probe.serverOk) { mark('install', 'done'); return; }
      mark('install', 'running');
      var result = await invoke('setup_install_server', { run: 'install' });
      state.bin = result.cortexBin;
      state.version = result.serverVersion;
      mark('install', 'done');
    }
    async function initialize(answers) {
      if (state.endpoint) { mark('config', 'done'); return; }
      mark('config', 'running');
      state.endpoint = await resolveEndpoint(answers);
      state.needsInit = false;
      mark('config', 'done');
    }
    async function resolveEndpoint(answers) {
      if (!state.needsInit) {
        return invoke('setup_enable_ui', { run: 'start', bin: state.bin, port: answers.port });
      }
      var result = await invoke('setup_run_init', { run: 'start', bin: state.bin, answers: answers });
      if (!result.uiUrl || !result.clientToken) throw new Error('INIT_ENDPOINT_MISSING');
      state.version = result.version || state.version;
      return { url: result.uiUrl, token: result.clientToken };
    }
    async function startDaemon() {
      mark('daemon', 'running');
      var success = await invoke('setup_start_daemon', { run: 'start', bin: state.bin,
        url: state.endpoint.url, token: state.endpoint.token });
      if (!success) throw new Error('DAEMON_TIMEOUT');
      mark('daemon', 'done');
    }
    async function autostart(enabled) {
      if (!enabled) return;
      mark('autostart', 'running');
      try {
        await invoke('setup_enable_autostart', { run: 'start' });
        mark('autostart', 'done');
      } catch (_) {
        state.warning = 'AUTOSTART_FAILED';
        mark('autostart', 'warning');
      }
    }
    async function connect() {
      mark('connect', 'running');
      await invoke('connect', { serverUrl: state.endpoint.url, token: state.endpoint.token,
        local: { cortexBin: state.bin, serverVersion: state.version || null } });
      mark('connect', 'done');
      state.destination = state.newInstall ? 'index.html#/setup/providers' : 'index.html';
      state.stage = 'ready';
    }
    async function start(answers) {
      return operation(async function () {
        state.stage = 'start';
        state.progress = {};
        await initialize(answers);
        await startDaemon();
        await autostart(answers.installService);
        await connect();
      });
    }
    function configure() {
      if (state.busy) return;
      state.stage = 'configure';
      state.error = null;
      state.endpoint = null;
      publish();
    }
    return { state: state, prepare: prepare, start: start, configure: configure };
  }
  root.CortexSetupFlow = createFlow;
})(globalThis);
