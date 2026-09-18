// input:  Node test runner + commands/lang handler factory + isolated preferences file
// output: !lang show / switch en↔zh / unknown-arg coverage + persistence + live setLocale
//         + the change notifier that lets open Web UIs follow a chat-side switch
// pos:    !lang command regression

import { describe, it, beforeEach, afterEach } from 'vitest';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLangHandler } from '../src/orchestration/routing/commands/lang.js';
import { setLocale, getLocale } from '../src/core/i18n.js';
import { _testSetPreferencesFile, loadLang } from '../src/domain/system/preferences.js';
import { MockAdapter } from '../src/platform/testing.js';

function tmpPrefs(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-lang-'));
  return path.join(dir, 'preferences.json');
}

describe('!lang command', () => {
  const adapter = new MockAdapter();
  let changed: string[] = [];
  const handleLangCmd = createLangHandler((loc) => { changed.push(loc); });
  beforeEach(() => {
    _testSetPreferencesFile(tmpPrefs());
    setLocale('en');
    changed = [];
  });
  afterEach(() => setLocale('en'));

  it('!lang zh switches the live locale and persists it', async () => {
    await handleLangCmd('chan', adapter as any, '!lang zh');
    assert.equal(getLocale(), 'zh');
    assert.equal(loadLang(), 'zh');
    // the notifier fires so an open SPA re-reads config.get and follows the switch
    assert.deepEqual(changed, ['zh']);
  });

  it('!lang en switches back', async () => {
    setLocale('zh');
    await handleLangCmd('chan', adapter as any, '!lang en');
    assert.equal(getLocale(), 'en');
    assert.equal(loadLang(), 'en');
  });

  it('unknown arg reports an error and does not change locale', async () => {
    const res = await handleLangCmd('chan', adapter as any, '!lang fr');
    assert.equal(getLocale(), 'en');
    assert.match((res as any).text, /fr/);
    assert.deepEqual(changed, []);
  });

});
