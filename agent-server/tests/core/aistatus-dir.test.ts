import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadAistatusDir, resolveAistatusDir } from '../../src/core/aistatus-dir.js';

const OS_HOME = path.join(os.tmpdir(), 'fixture-os-home');
let configDir: string;

beforeEach(() => { configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aistatus-dir-')); });
afterEach(() => fs.rmSync(configDir, { recursive: true, force: true }));

describe('the aistatus directory', () => {
  it('is .aistatus under the OS home by default', () => {
    expect(resolveAistatusDir({}, {}, OS_HOME)).toBe(path.join(OS_HOME, '.aistatus'));
  });

  it('moves under CORTEX_GATEWAY_HOME, the process env winning over config/.env', () => {
    const fromEnv = path.join(os.tmpdir(), 'env-home');
    const fromFile = path.join(os.tmpdir(), 'file-home');
    expect(resolveAistatusDir({}, { CORTEX_GATEWAY_HOME: fromFile }, OS_HOME)).toBe(path.join(fromFile, '.aistatus'));
    expect(resolveAistatusDir({ CORTEX_GATEWAY_HOME: fromEnv }, { CORTEX_GATEWAY_HOME: fromFile }, OS_HOME))
      .toBe(path.join(fromEnv, '.aistatus'));
  });

  it('refuses a relative home', () => {
    expect(() => resolveAistatusDir({ CORTEX_GATEWAY_HOME: 'relative' }, {}, OS_HOME)).toThrow(/absolute/);
  });

  it('reads config/.env, which a CLI process has not loaded', () => {
    const home = path.join(os.tmpdir(), 'dotenv-home');
    fs.writeFileSync(path.join(configDir, '.env'), `CORTEX_GATEWAY_HOME=${home}\n`);
    expect(loadAistatusDir(configDir, {}, OS_HOME)).toBe(path.join(home, '.aistatus'));
    expect(loadAistatusDir(path.join(configDir, 'missing'), {}, OS_HOME)).toBe(path.join(OS_HOME, '.aistatus'));
  });
});
