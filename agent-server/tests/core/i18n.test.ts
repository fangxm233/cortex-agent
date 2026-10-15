import { describe, it, afterEach } from 'vitest';
import * as assert from 'node:assert/strict';
import { t, setLocale, normalizeLocale, detectSystemLocale } from '../../src/core/i18n.js';
import { en } from '../../src/core/locales/en.js';
import { zh } from '../../src/core/locales/zh.js';

describe('i18n', () => {
  afterEach(() => setLocale('en'));

  it('normalizeLocale maps known values and falls back to en', () => {
    assert.equal(normalizeLocale('zh'), 'zh');
    assert.equal(normalizeLocale('en'), 'en');
    assert.equal(normalizeLocale('fr'), 'en');
    assert.equal(normalizeLocale(undefined), 'en');
    assert.equal(normalizeLocale(''), 'en');
  });

  it('detectSystemLocale maps Chinese locale env vars to zh', () => {
    assert.equal(detectSystemLocale({ LANG: 'zh_CN.UTF-8' }), 'zh');
    assert.equal(detectSystemLocale({ LC_ALL: 'zh_TW.UTF-8' }), 'zh');
    assert.equal(detectSystemLocale({ LANGUAGE: 'zh_CN:en_US' }), 'zh');
    assert.equal(detectSystemLocale({ LC_MESSAGES: 'zh-Hans' }), 'zh');
  });

  it('detectSystemLocale defaults to en for non-Chinese / unset env', () => {
    assert.equal(detectSystemLocale({ LANG: 'en_US.UTF-8' }), 'en');
    assert.equal(detectSystemLocale({ LANG: 'fr_FR.UTF-8' }), 'en');
    assert.equal(detectSystemLocale({ LANG: 'C' }), 'en');
    assert.equal(detectSystemLocale({}), 'en');
  });

  it('detectSystemLocale precedence: LC_ALL > LC_MESSAGES > LANG > LANGUAGE', () => {
    // LC_ALL overrides everything, even a Chinese LANG
    assert.equal(detectSystemLocale({ LC_ALL: 'en_US.UTF-8', LANG: 'zh_CN.UTF-8' }), 'en');
    // LANG used when LC_ALL/LC_MESSAGES absent
    assert.equal(detectSystemLocale({ LANG: 'zh_CN.UTF-8', LANGUAGE: 'en' }), 'zh');
  });

  it('t interpolates ${param} placeholders', () => {
    setLocale('en');
    // lang.switched contains a ${lang} placeholder in both locales
    const out = t('lang.switched', { lang: 'zh' });
    assert.match(out, /zh/);
    assert.ok(!out.includes('${'), 'no unresolved placeholders');
  });

  it('t falls back to en when a key is absent in the active locale', () => {
    // Force a key that exists only in en by temporarily casting; runtime fallback path.
    setLocale('zh');
    const key = '__test.only_en__' as any;
    (en as any)[key] = 'english-only';
    try {
      assert.equal(t(key), 'english-only');
    } finally {
      delete (en as any)[key];
    }
  });

  it('model selection vocabulary has no retired preset keys or wording', () => {
    for (const messages of [en, zh]) {
      assert.doesNotMatch(JSON.stringify(messages), /profile/i);
    }
  });

  it('selection messages interpolate the same fields in both locales', () => {
    for (const locale of ['en', 'zh'] as const) {
      setLocale(locale);
      assert.doesNotMatch(t('cmd.session.newConversation', { selection: 'pi · flash' }), /\$\{/);
      assert.doesNotMatch(t('interaction.sessionSelectionNote', { selection: 'claude · opus' }), /\$\{/);
      assert.doesNotMatch(t('schedule.help.availableModels', { modelNames: 'opus, flash' }), /\$\{/);
      assert.doesNotMatch(t('init.gatewaySetup.generatedModels', { names: 'opus', default: 'opus' }), /\$\{/);
    }
  });

  it('t falls back to the raw key when unknown everywhere', () => {
    assert.equal(t('totally.unknown.key' as any), 'totally.unknown.key');
  });

});
