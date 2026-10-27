import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowsTarget, verifyTarget } from './sea-target.mjs';

test('read Windows platform, architecture and version from the executable', () => {
  const bytes = Buffer.alloc(256);
  bytes.writeUInt32LE(64, 0x3c); bytes.write('PE\0\0', 64); bytes.writeUInt16LE(0x8664, 68);
  Buffer.from('bd04effe00000100', 'hex').copy(bytes, 128);
  bytes.writeUInt32LE((26 << 16) | 12, 136); bytes.writeUInt32LE(1 << 16, 140);
  assert.deepEqual(windowsTarget(bytes), { platform: 'win32', arch: 'x64', version: 'v26.12.1' });
});

test('reject a target label which does not match the executable', () => {
  const other = process.platform === 'win32' ? 'linux' : 'win32';
  assert.throws(() => verifyTarget(process.execPath, other, process.arch, false), /target mismatch/);
});
