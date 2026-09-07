// input:  stored language, theme, translated native markup
// output: CortexShell language and presentation helpers
// pos:    Shared interaction chrome for native setup pages
// >>> Once updated, update this header and the parent CORTEX.md <<<
(function () {
  'use strict';
  var el = function (id) { return document.getElementById(id); };
  function stored(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, value); } catch (_) {}
  }
  var lang = stored('cortex.lang') || (navigator.language.startsWith('zh') ? 'zh' : 'en');
  function t(en, zh) { return lang === 'zh' ? zh : en; }
  function applyLanguage() {
    document.documentElement.lang = t('en', 'zh-CN');
    document.querySelectorAll('[data-en]').forEach(function (node) {
      node.textContent = node.getAttribute('data-' + lang);
    });
    ['en', 'zh'].forEach(function (key) {
      el('cx-lang-' + key).classList.toggle('active', lang === key);
      el('cx-lang-' + key).setAttribute('aria-pressed', String(lang === key));
    });
    window.dispatchEvent(new Event('cortex-language'));
  }
  function setLanguage(next) {
    lang = next;
    save('cortex.lang', next);
    applyLanguage();
  }
  function toggleTheme() {
    var root = document.documentElement;
    var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    root.style.colorScheme = next;
    save('cortex.theme', next);
  }
  ['en', 'zh'].forEach(function (key) {
    el('cx-lang-' + key).addEventListener('click', function () { setLanguage(key); });
  });
  el('cx-theme').addEventListener('click', toggleTheme);
  window.CortexShell = { el: el, t: t, lang: function () { return lang; },
    invoke: function (command, args) {
      if (!window.__TAURI__) return Promise.reject(new Error(t('Open this page in the Cortex app.', '请在 Cortex 原生应用中打开此页面。')));
      return window.__TAURI__.core.invoke(command, args);
    } };
  applyLanguage();
})();
