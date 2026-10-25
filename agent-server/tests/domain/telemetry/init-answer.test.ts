import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'vitest';
import { parseInitAnswersJson } from '@entry/init.js';
import { applyInitTelemetry, parseInitTelemetryAnswer } from '@domain/telemetry/init-answer.js';

const DESKTOP_ID = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';

function home() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'telemetry-init-'));
  return { configDir: path.join(root, 'config'), storeDir: path.join(root, 'data') };
}

test('init --answers reads the telemetry choice and the desktop install id', () => {
  assert.deepEqual(
    parseInitAnswersJson(JSON.stringify({ telemetry: { enabled: false, installId: DESKTOP_ID } })).telemetry,
    { enabled: false, installId: DESKTOP_ID },
  );
  assert.deepEqual(parseInitAnswersJson('{"telemetry":{"enabled":true}}').telemetry, { enabled: true });
  assert.equal(parseInitAnswersJson('{}').telemetry, undefined);
  assert.equal(parseInitTelemetryAnswer({ enabled: 'yes' }), undefined);
  assert.equal(parseInitTelemetryAnswer({ enabled: true, installId: 'not-a-uuid' }), undefined);
});

test('the choice is saved in settings.json next to existing settings', () => {
  const dirs = home();
  mkdirSync(dirs.configDir, { recursive: true });
  writeFileSync(path.join(dirs.configDir, 'settings.json'), JSON.stringify({ teamEnabled: false }));
  applyInitTelemetry({ enabled: false }, dirs);
  const settings = JSON.parse(readFileSync(path.join(dirs.configDir, 'settings.json'), 'utf8'));
  assert.deepEqual(settings, { teamEnabled: false, telemetryEnabled: false });
});

test('the desktop install id is adopted only when the home has none yet', () => {
  const fresh = home();
  applyInitTelemetry({ enabled: true, installId: DESKTOP_ID }, fresh);
  const idFile = path.join(fresh.storeDir, 'telemetry', 'install-id');
  assert.equal(readFileSync(idFile, 'utf8').trim(), DESKTOP_ID);

  const existing = home();
  const ownId = '11111111-2222-4333-8444-555555555555';
  mkdirSync(path.join(existing.storeDir, 'telemetry'), { recursive: true });
  writeFileSync(path.join(existing.storeDir, 'telemetry', 'install-id'), `${ownId}\n`);
  applyInitTelemetry({ enabled: true, installId: DESKTOP_ID }, existing);
  assert.equal(readFileSync(path.join(existing.storeDir, 'telemetry', 'install-id'), 'utf8').trim(), ownId);
});
