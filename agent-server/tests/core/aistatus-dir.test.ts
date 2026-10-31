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

  it('moves under CORTEX_AISTATUS_HOME, the process env winning over config/.env', () => {
    const fromEnv = path.join(os.tmpdir(), 'env-home');
    const fromFile = path.join(os.tmpdir(), 'file-home');
    expect(resolveAistatusDir({}, { CORTEX_AISTATUS_HOME: fromFile }, OS_HOME)).toBe(path.join(fromFile, '.aistatus'));
    expect(resolveAistatusDir({ CORTEX_AISTATUS_HOME: fromEnv }, { CORTEX_AISTATUS_HOME: fromFile }, OS_HOME))
      .toBe(path.join(fromEnv, '.aistatus'));
  });

  it('still reads the setting\'s earlier name, CORTEX_GATEWAY_HOME, below the current one', () => {
    const current = path.join(os.tmpdir(), 'current-home');
    const earlier = path.join(os.tmpdir(), 'earlier-home');
    expect(resolveAistatusDir({ CORTEX_GATEWAY_HOME: earlier }, {}, OS_HOME)).toBe(path.join(earlier, '.aistatus'));
    expect(resolveAistatusDir({ CORTEX_GATEWAY_HOME: earlier }, { CORTEX_AISTATUS_HOME: current }, OS_HOME))
      .toBe(path.join(earlier, '.aistatus'));
    expect(resolveAistatusDir({ CORTEX_GATEWAY_HOME: earlier, CORTEX_AISTATUS_HOME: current }, {}, OS_HOME))
      .toBe(path.join(current, '.aistatus'));
  });

  it('refuses a relative home', () => {
    expect(() => resolveAistatusDir({ CORTEX_AISTATUS_HOME: 'relative' }, {}, OS_HOME)).toThrow(/absolute/);
  });

  it('reads config/.env, which a CLI process has not loaded', () => {
    const home = path.join(os.tmpdir(), 'dotenv-home');
    fs.writeFileSync(path.join(configDir, '.env'), `CORTEX_AISTATUS_HOME=${home}\n`);
    expect(loadAistatusDir(configDir, {}, OS_HOME)).toBe(path.join(home, '.aistatus'));
    expect(loadAistatusDir(path.join(configDir, 'missing'), {}, OS_HOME)).toBe(path.join(OS_HOME, '.aistatus'));
  });
});
