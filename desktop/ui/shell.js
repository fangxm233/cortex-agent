// input:  stored language, theme, translated native markup, injected title-bar mode
// output: CortexShell language helpers and the app-drawn setup title bar
// pos:    Shared interaction chrome for native setup pages
// >>> Once updated, update this header and the parent AGENTS.md <<<
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
  // ── App-drawn window chrome ───────────────────────────────────────────────
  // The desktop shell opens the window undecorated on Windows/Linux and with
  // TitleBarStyle::Overlay on macOS (desktop/src-tauri/src/lib.rs), so the page
  // itself owns the title bar. These setup screens are shown BEFORE the SPA can
  // load, so they must paint that bar too — otherwise the window has no drag
  // surface and no close button for the whole onboarding flow. Mirrors
  // web/src/features/provider-setup/SetupHeader.tsx + shell/WindowControls.tsx.
  var SEGOE = { minimize: '', maximize: '', restore: '', close: '' };
  var STROKE = 'fill="none" stroke="currentColor" stroke-width="1.2"';
  var SHAPE = {
    minimize: '<line x1="1.5" y1="6" x2="10.5" y2="6" ' + STROKE + '/>',
    maximize: '<rect x="1.8" y="1.8" width="8.4" height="8.4" ' + STROKE + '/>',
    restore: '<rect x="1.5" y="3.4" width="7" height="7" ' + STROKE + '/>'
      + '<path d="M3.9 3.4V1.5h6.6v6.6H8.6" ' + STROKE + '/>',
    close: '<path d="M2 2l8 8M10 2l-8 8" ' + STROKE + '/>'
  };
  function titleBarMode() {
    var mode = window.__CORTEX_TITLEBAR__;
    return mode === 'custom' || mode === 'overlay' ? mode : 'native';
  }
  function glyph(name) {
    if (window.__CORTEX_PLATFORM__ === 'windows') {
      return '<span class="caption-glyph">' + SEGOE[name] + '</span>';
    }
    return '<svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">' + SHAPE[name] + '</svg>';
  }
  function windowCommand(name) {
    if (!window.__TAURI__) return Promise.resolve();
    return window.__TAURI__.core.invoke('plugin:window|' + name, { label: 'main' })
      .catch(function () {});
  }
  function drawCaptionButtons(header) {
    var group = document.createElement('div');
    group.className = 'caption-buttons';
    header.appendChild(group);
    var maximized = false;
    var buttons = [
      { name: 'minimize', command: 'minimize', en: 'Minimize', zh: '最小化' },
      { name: 'maximize', command: 'toggle_maximize', en: 'Maximize', zh: '最大化' },
      { name: 'close', command: 'close', en: 'Close', zh: '关闭', danger: true }
    ].map(function (spec) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'caption-button' + (spec.danger ? ' danger' : '');
      // Tauri's "deep" drag region drags on non-clickable children; opt these out
      // explicitly so a click on a caption button never starts a window drag.
      button.setAttribute('data-tauri-drag-region', 'false');
      button.addEventListener('click', function () { windowCommand(spec.command); });
      group.appendChild(button);
      return { spec: spec, node: button };
    });
    function render() {
      buttons.forEach(function (entry) {
        var restore = entry.spec.name === 'maximize' && maximized;
        var label = restore ? t('Restore', '还原') : t(entry.spec.en, entry.spec.zh);
        entry.node.setAttribute('aria-label', label);
        entry.node.title = label;
        entry.node.innerHTML = glyph(restore ? 'restore' : entry.spec.name);
      });
    }
    function sync() {
      if (!window.__TAURI__) return;
      window.__TAURI__.core.invoke('plugin:window|is_maximized', { label: 'main' })
        .then(function (value) {
          if (value === maximized) return;
          maximized = value;
          render();
        })
        .catch(function () {});
    }
    render();
    sync();
    window.addEventListener('resize', sync);
    window.addEventListener('focus', sync);
    window.addEventListener('cortex-language', render);
  }
  function applyWindowChrome() {
    var header = document.querySelector('.app-header');
    if (!header) return;
    var mode = titleBarMode();
    header.setAttribute('data-caption', mode);
    if (mode === 'native') return;
    header.setAttribute('data-tauri-drag-region', 'deep');
    // macOS keeps its real traffic lights under the overlay title bar; leave room.
    // 94px = captionInsetLeft() 78 + 16, same as SetupHeader.tsx (web/src/lib/desktop-platform.ts).
    if (mode === 'overlay') header.style.paddingLeft = '94px';
    else drawCaptionButtons(header);
  }

  ['en', 'zh'].forEach(function (key) {
    el('cx-lang-' + key).addEventListener('click', function () { setLanguage(key); });
  });
  el('cx-theme').addEventListener('click', toggleTheme);
  applyWindowChrome();
  window.CortexShell = { el: el, t: t, lang: function () { return lang; },
    invoke: function (command, args) {
      if (!window.__TAURI__) return Promise.reject(new Error(t('Open this page in the Cortex app.', '请在 Cortex 原生应用中打开此页面。')));
      return window.__TAURI__.core.invoke(command, args);
    } };
  applyLanguage();
})();
