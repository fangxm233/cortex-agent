import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'vitest';
import { PI_DEVICE_ID_FILE, getPiDeviceId } from '../../src/domain/auth/pi-device-id.js';
import { isInstallId } from '../../src/domain/telemetry/install-id.js';
import { INSTALL_ID_FILE } from '../../src/domain/telemetry/paths.js';

test('the PI device ID is a UUID created once and kept apart from the telemetry install id', () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'pi-device-id-')), 'pi', 'device-id');
  const id = getPiDeviceId(file);

  assert.ok(isInstallId(id));
  assert.equal(getPiDeviceId(file), id);
  assert.equal(readFileSync(file, 'utf8').trim(), id);
  assert.notEqual(PI_DEVICE_ID_FILE, INSTALL_ID_FILE);
});
