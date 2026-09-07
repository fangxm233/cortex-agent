// input:  native progress events, setup controller, form answers
// output: responsive installation and configuration views
// pos:    DOM presentation for automatic native onboarding
// >>> Once updated, update this header and the parent CORTEX.md <<<
(function () {
  'use strict';
  var shell = window.CortexShell, el = shell.el, t = shell.t;
  var answers = null, latest = null, unlisten = null, navigating = false;
  var labels = {
    check: ['Check this computer', '检查本机环境'], install: ['Install the server', '安装服务端'],
    config: ['Save configuration', '写入配置'], daemon: ['Start the server', '启动服务端'],
    autostart: ['Enable auto-start', '开启自动启动'], connect: ['Connect your workspace', '连接工作台'],
  };
  var errors = {
    NODE_REQUIRED: ['Install Node.js 20 or newer from nodejs.org, then try again. If you use nvm, open Cortex from your terminal.', '请先从 nodejs.org 安装 Node.js 20 或更高版本，再重试。使用 nvm 时可从终端启动 Cortex。'],
    NPM_REQUIRED: ['npm was not found. Repair your Node.js installation, then try again.', '未找到 npm，请修复 Node.js 安装后重试。'],
    GIT_REQUIRED: ['Install Git from git-scm.com, then try again.', '请先从 git-scm.com 安装 Git，再重试。'],
    EACCES: ['npm cannot write to its global directory. Use a user-owned npm prefix, then try again.', 'npm 无法写入全局目录，请将 npm prefix 设置为当前用户可写的目录后重试。'],
    DAEMON_TIMEOUT: ['The server has not answered yet. Check the activity log, then try again.', '服务端尚未响应，请查看运行日志后重试。'],
    INIT_ENDPOINT_MISSING: ['The server did not return connection details. Check that its version supports desktop setup.', '服务端未返回连接信息，请检查其版本是否支持桌面初始化。'],
  };
  function translated(pair) { return t(pair[0], pair[1]); }
  function addLog(event) {
    var data = event.payload || {};
    if (data.run !== 'install' && data.run !== 'start') return;
    var line = String(data.line || '').replace(/\x1b\[[0-9;]*m/g, '');
    el('cx-log').textContent = (el('cx-log').textContent + line + '\n').slice(-24000);
    el('cx-log').scrollTop = el('cx-log').scrollHeight;
  }
  function subscribe() {
    if (!window.__TAURI__) return Promise.resolve();
    return window.__TAURI__.event.listen('setup-log', addLog).then(function (stop) { unlisten = stop; });
  }
  function header(state) {
    var starting = state.stage === 'start' || state.stage === 'ready';
    el('cx-progress-label').textContent = starting ? t('ALMOST THERE', '即将就绪') : t('LOCAL INSTALLATION', '本机安装');
    el('cx-progress-title').textContent = starting ? t('Opening your workspace.', '正在打开你的工作台。') : t('Getting Cortex ready.', '正在准备 Cortex。');
    el('cx-progress-intro').textContent = starting
      ? t('Saving your settings, starting the server and connecting — all in one go.', '正在保存设置、启动服务端并建立连接，无需其他操作。')
      : t('We’ll check what’s available and install what’s needed. No extra steps.', '自动检查已有环境并安装所需组件，无需逐步确认。');
    el('cx-progress-heading').textContent = starting ? t('Starting Cortex', '启动 Cortex') : t('Preparing this computer', '准备本机环境');
    el('cx-progress-tag').textContent = state.error ? t('Needs attention', '需要处理') : t('Automatic', '自动进行');
  }
  function row(key, state) {
    var status = state.progress[key] || 'pending';
    var node = document.createElement('div');
    node.className = 'status-row'; node.dataset.status = status;
    var icon = document.createElement('span'); icon.className = 'status-icon'; icon.setAttribute('aria-hidden', 'true');
    icon.textContent = { done: '✓', error: '!', warning: '!' }[status] || '';
    var copy = document.createElement('div'), title = document.createElement('strong');
    title.textContent = translated(labels[key]); copy.appendChild(title);
    appendDetail(copy, key, state);
    var value = document.createElement('span'); value.className = 'status-value';
    var values = { pending: ['Waiting', '等待'], running: ['Working…', '进行中…'], done: ['Ready', '就绪'], error: ['Failed', '失败'], warning: ['Skipped', '已跳过'] };
    value.textContent = translated(values[status]);
    node.append(icon, copy, value);
    return node;
  }
  function appendDetail(copy, key, state) {
    var details = { check: state.probe && ['Node ' + state.probe.node, 'npm ' + state.probe.npm, state.probe.git].filter(Boolean).join(' · '), install: state.version && 'Cortex ' + state.version };
    if (!details[key]) return;
    var node = document.createElement('p'); node.className = 'probe-details';
    node.textContent = details[key]; copy.appendChild(node);
  }
  function progress(state) {
    var keys = state.stage === 'prepare' ? ['check', 'install'] : ['config', 'daemon', 'connect'];
    if (answers && answers.installService && state.stage !== 'prepare') keys.splice(2, 0, 'autostart');
    el('cx-checks').replaceChildren.apply(el('cx-checks'), keys.map(function (key) { return row(key, state); }));
  }
  function configure(state) {
    if (state.stage !== 'configure') return;
    el('cx-version').textContent = 'Cortex ' + (state.version || '');
    el('cx-existing').hidden = state.needsInit;
    el('cx-config-fields').hidden = !state.needsInit;
    el('cx-config-fields').disabled = !state.needsInit;
    el('cx-autostart-row').hidden = state.probe.os === 'windows';
    if (!el('cx-machine').value) el('cx-machine').value = state.probe.hostname || '';
  }
  function renderError(state) {
    el('cx-error').hidden = !state.error;
    el('cx-edit').hidden = state.stage !== 'start';
    if (!state.error) return;
    el('cx-error-title').textContent = t('Couldn’t finish this step', '这一步未能完成');
    el('cx-error-message').textContent = errors[state.error] ? translated(errors[state.error]) : state.error;
    el('cx-log-details').open = true;
  }
  function render(state) {
    latest = state;
    el('cx-configure').hidden = state.stage !== 'configure';
    el('cx-progress').hidden = state.stage === 'configure';
    el('cx-working-note').hidden = state.stage === 'configure' || !!state.error;
    el('cx-start').disabled = state.busy;
    el('cx-retry').disabled = state.busy;
    header(state); progress(state); configure(state); renderError(state);
    if (state.stage === 'ready') finish(state);
  }
  function finish(state) {
    if (navigating) return;
    navigating = true;
    el('cx-progress-title').textContent = t('Your workspace is ready.', '工作台已就绪。');
    if (state.warning) el('cx-progress-intro').textContent = t('Connected. Auto-start could not be enabled; open this app to start Cortex.', '已连接，但未能开启自动启动；之后打开本应用即可启动 Cortex。');
    setTimeout(function () { window.location.href = 'index.html'; }, state.warning ? 3500 : 600);
  }
  function readAnswers() {
    var backends = [];
    if (el('cx-backend-claude').checked) backends.push('claude');
    if (el('cx-backend-pi').checked) backends.push('pi');
    return { lang: shell.lang(), machineName: el('cx-machine').value.trim(), backends: backends,
      installService: el('cx-autostart').checked && !el('cx-autostart-row').hidden && latest.needsInit,
      port: Number(el('cx-port').value) };
  }
  var controller = window.CortexSetupFlow(shell.invoke, render, subscribe());
  el('cx-config-form').addEventListener('submit', function (event) {
    event.preventDefault(); answers = readAnswers();
    if (latest.needsInit && (!answers.machineName || !answers.backends.length)) {
      el('cx-machine').setCustomValidity(answers.machineName ? '' : t('Enter a machine name.', '请输入机器名称。'));
      el('cx-backend-claude').setCustomValidity(answers.backends.length ? '' : t('Select at least one backend.', '请至少选择一个后端。'));
      el('cx-config-form').reportValidity(); return;
    }
    el('cx-log').textContent = ''; controller.start(answers);
  });
  el('cx-config-form').addEventListener('input', function () {
    el('cx-machine').setCustomValidity(''); el('cx-backend-claude').setCustomValidity('');
  });
  el('cx-retry').addEventListener('click', function () {
    if (latest.stage === 'prepare') { controller.prepare(); return; }
    controller.start(answers);
  });
  el('cx-edit').addEventListener('click', controller.configure);
  window.addEventListener('cortex-language', function () { if (latest) render(latest); });
  window.addEventListener('beforeunload', function () { if (unlisten) unlisten(); });
  controller.prepare();
})();
