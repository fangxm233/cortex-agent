// input:  native connection bridge, remote server form
// output: tested connection persisted before workbench navigation
// pos:    Local install entry and remote connection behavior
// >>> Once updated, update this header and the parent CORTEX.md <<<
(function () {
  'use strict';
  var shell = window.CortexShell, el = shell.el, t = shell.t;
  var busy = false;
  function showRemote(on) {
    el('cx-chooser').hidden = on;
    el('cx-remote').hidden = !on;
    el('cx-back').hidden = !!window.__CORTEX_MOBILE__;
    if (on) el('cx-server-url').focus();
  }
  function setStatus(message, tone) {
    el('cx-status').textContent = message;
    el('cx-status').dataset.tone = tone;
  }
  function setBusy(on) {
    busy = on;
    ['cx-btn-test', 'cx-btn-connect', 'cx-server-url', 'cx-token', 'cx-back'].forEach(function (id) {
      el(id).disabled = on;
    });
  }
  function fields() {
    return { serverUrl: el('cx-server-url').value.trim().replace(/\/+$/, ''), token: el('cx-token').value.trim() };
  }
  async function probe(connection) {
    var response = await fetch(connection.serverUrl + '/trpc/', {
      headers: { 'x-cortex-token': connection.token }, signal: AbortSignal.timeout(8000),
    });
    if (response.status === 401) throw new Error(t('The client token was not accepted. Check the server’s CORTEX_CLIENT_TOKEN.', '令牌未通过验证，请检查服务端的 CORTEX_CLIENT_TOKEN。'));
  }
  async function connect(save) {
    if (busy || !el('cx-remote-form').reportValidity()) return;
    var connection = fields();
    if (!connection.token) { setStatus(t('Enter a client token.', '请填写客户端令牌。'), 'error'); return; }
    setBusy(true);
    setStatus(t('Connecting to your server…', '正在连接服务器…'), 'pending');
    try {
      await probe(connection);
      if (!save) { setStatus(t('Connection verified. Ready to connect.', '连接验证通过，可以进入工作台。'), 'ok'); return; }
      await shell.invoke('connect', connection);
      setStatus(t('Connected. Opening your workspace…', '连接成功，正在打开工作台…'), 'ok');
      window.location.href = 'index.html';
    } catch (error) {
      setStatus(String(error.message || error), 'error');
    } finally { setBusy(false); }
  }
  el('cx-opt-local').addEventListener('click', function () { window.location.href = 'setup.html'; });
  el('cx-opt-remote').addEventListener('click', function () { showRemote(true); });
  el('cx-back').addEventListener('click', function () { setStatus('', ''); showRemote(false); });
  el('cx-btn-test').addEventListener('click', function () { connect(false); });
  el('cx-remote-form').addEventListener('submit', function (event) { event.preventDefault(); connect(true); });
  showRemote(!!window.__CORTEX_MOBILE__);
  shell.invoke('get_connection_config').then(function (config) {
    if (config.serverUrl) el('cx-server-url').value = config.serverUrl;
  }).catch(function () {});
})();
