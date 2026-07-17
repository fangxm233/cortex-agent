// input:  Node test runner + commands/lang handler + isolated preferences file
// output: !lang show / switch en↔zh / unknown-arg coverage + persistence + live setLocale
// pos:    !lang command regression
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, it, beforeEach, afterEach } from 'vitest';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleLangCmd } from '../src/orchestration/routing/commands/lang.js';
import { setLocale, getLocale } from '../src/core/i18n.js';
import { _testSetPreferencesFile, loadLang } from '../src/domain/system/preferences.js';
import { MockAdapter } from '../src/platform/testing.js';

function tmpPrefs(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-lang-'));
  return path.join(dir, 'preferences.json');
}

describe('!lang command', () => {
  const adapter = new MockAdapter();
  beforeEach(() => {
    _testSetPreferencesFile(tmpPrefs());
    setLocale('en');
  });
  afterEach(() => setLocale('en'));

  it('with no arg shows current language + available + usage', async () => {
    const res = await handleLangCmd('chan', adapter as any, '!lang');
    assert.ok(res && 'text' in res);
    assert.match((res as any).text, /English/);
    assert.match((res as any).text, /!lang/);
  });

  it('!lang zh switches the live locale and persists it', async () => {
    const res = await handleLangCmd('chan', adapter as any, '!lang zh');
    assert.equal(getLocale(), 'zh');
    assert.equal(loadLang(), 'zh');
    // confirmation rendered in the NEW locale (Chinese)
    assert.match((res as any).text, /中文/);
  });

  it('!lang en switches back', async () => {
    setLocale('zh');
    const res = await handleLangCmd('chan', adapter as any, '!lang en');
    assert.equal(getLocale(), 'en');
    assert.equal(loadLang(), 'en');
    assert.match((res as any).text, /English/);
  });

  it('unknown arg reports an error and does not change locale', async () => {
    const res = await handleLangCmd('chan', adapter as any, '!lang fr');
    assert.equal(getLocale(), 'en');
    assert.match((res as any).text, /fr/);
  });
});
