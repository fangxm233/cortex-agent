// Test-only network guards. The aistatus home relocation uses the real startup settings.
import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { installGuards } from './bundle-daemon-guards.mjs';
for (const key of ['HOME', 'CORTEX_HOME', 'CORTEX_GATEWAY_HOME']) {
  assert(isAbsolute(process.env[key] ?? ''), `Bundle tests require an isolated ${key}`);
}
const ports = [Number(process.env.CORTEX_UI_PORT)];
assert(ports.every(value => Number.isInteger(value) && value >= 1024 && value <= 65535 && value !== 9880));
installGuards(() => {}, ports);
