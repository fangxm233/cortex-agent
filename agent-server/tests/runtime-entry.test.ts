import { expect, test } from 'vitest';
import { runtimeEntry } from '../src/core/runtime-entry.js';

test('ordinary Node preserves the script path', () => {
  expect(runtimeEntry('/opt/cortex/dist/entry/app.js', false)).toBe('/opt/cortex/dist/entry/app.js');
});

test('SEA dispatch is a single argument, preserving MCP argument positions', () => {
  expect(runtimeEntry('C:\\Program Files\\Cortex\\app.js', true)).toBe('--entry=C:\\Program Files\\Cortex\\app.js');
});
