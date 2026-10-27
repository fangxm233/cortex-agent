// Test-only network guards. Gateway relocation uses the real startup settings.
import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { installGuards } from './bundle-daemon-guards.mjs';
const port = Number(process.env.CORTEX_GATEWAY_PORT);
for (const key of ['HOME', 'CORTEX_HOME', 'CORTEX_GATEWAY_HOME']) {
  assert(isAbsolute(process.env[key] ?? ''), `Bundle tests require an isolated ${key}`);
}
const ports = [port, ...['WEBHOOK_PORT', 'CORTEX_CLIENT_PORT', 'CORTEX_TUI_PORT', 'CORTEX_UI_PORT'].map(key => Number(process.env[key]))];
assert(ports.every(value => Number.isInteger(value) && value >= 1024 && value <= 65535 && value !== 9880));
installGuards(() => {}, ports);
