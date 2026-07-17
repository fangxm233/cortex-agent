// input:  Node test runner + domain/system/preferences module (isolated temp file)
// output: loadPreferences / loadLang / setLang round-trip + default + malformed coverage
// pos:    Operator display-preferences store (config/preferences.json) regression
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, it, beforeEach } from 'vitest';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadPreferences, loadLang, setLang, _testSetPreferencesFile } from '../src/domain/system/preferences.js';

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-prefs-'));
  return path.join(dir, 'preferences.json');
}

describe('preferences', () => {
  let file: string;
  beforeEach(() => {
    file = tmpFile();
    _testSetPreferencesFile(file);
  });

  it('loadLang defaults to en when the file is missing', () => {
    assert.equal(loadLang(), 'en');
    assert.deepEqual(loadPreferences(), {});
  });

  it('setLang persists and loadLang reads it back', () => {
    setLang('zh');
    assert.equal(loadLang(), 'zh');
    assert.equal(loadPreferences().lang, 'zh');
    // persisted to disk as JSON
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(onDisk.lang, 'zh');
  });

  it('setLang normalizes unknown input to en', () => {
    setLang('fr' as any);
    assert.equal(loadLang(), 'en');
  });

  it('setLang preserves other preference keys', () => {
    fs.writeFileSync(file, JSON.stringify({ lang: 'en', dateFormat: 'iso' }));
    setLang('zh');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(onDisk.lang, 'zh');
    assert.equal(onDisk.dateFormat, 'iso', 'unrelated keys must survive');
  });

  it('loadLang falls back to en on malformed JSON', () => {
    fs.writeFileSync(file, '{ not json');
    assert.equal(loadLang(), 'en');
  });
});
