import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'vitest';
import { parse as yamlParse } from 'yaml';

import {
  readUsageSharing,
  usageSharingIssues,
  writeUsageSharing,
} from '../../../src/domain/costs/aistatus-config.js';

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'cortex-aistatus-config-'));
}

function readYaml(dir: string): Record<string, unknown> {
  return yamlParse(readFileSync(path.join(dir, 'config.yaml'), 'utf-8'));
}

test('a missing config reads as disabled with empty identity fields', () => {
  assert.deepEqual(readUsageSharing(path.join(tmpDir(), 'absent')), {
    enabled: false, name: '', org: '', email: '',
  });
});

test('an unparseable config reads as disabled', () => {
  const dir = tmpDir();
  writeFileSync(path.join(dir, 'config.yaml'), 'name: [unclosed\n');
  assert.deepEqual(readUsageSharing(dir), { enabled: false, name: '', org: '', email: '' });
});

test('enabling writes the identity and creates the directory', () => {
  const dir = path.join(tmpDir(), 'nested');
  writeUsageSharing({ enabled: true, name: 'Ada', org: 'Lab', email: 'ada@example.com' }, dir);

  assert.deepEqual(readYaml(dir), {
    name: 'Ada', org: 'Lab', email: 'ada@example.com', uploadEnabled: true,
  });
  assert.deepEqual(readUsageSharing(dir), {
    enabled: true, name: 'Ada', org: 'Lab', email: 'ada@example.com',
  });
});

test('writing preserves keys this module does not own', () => {
  const dir = tmpDir();
  writeFileSync(path.join(dir, 'config.yaml'), 'name: Old\nextra: keep-me\nuploadEnabled: false\n');

  writeUsageSharing({ enabled: true, name: 'Ada', email: 'ada@example.com' }, dir);

  assert.deepEqual(readYaml(dir), {
    name: 'Ada', extra: 'keep-me', org: '', email: 'ada@example.com', uploadEnabled: true,
  });
});

test('disabling keeps the stored identity and ignores submitted fields', () => {
  const dir = tmpDir();
  writeUsageSharing({ enabled: true, name: 'Ada', org: 'Lab', email: 'ada@example.com' }, dir);

  writeUsageSharing({ enabled: false, name: 'Other', org: '', email: '' }, dir);

  assert.deepEqual(readUsageSharing(dir), {
    enabled: false, name: 'Ada', org: 'Lab', email: 'ada@example.com',
  });
});

test('disabling with no prior file writes an empty identity', () => {
  const dir = tmpDir();
  writeUsageSharing({ enabled: false }, dir);
  assert.ok(existsSync(path.join(dir, 'config.yaml')));
  assert.deepEqual(readYaml(dir), { name: '', org: '', email: '', uploadEnabled: false });
});

test('enabling requires a name and a valid-looking email', () => {
  assert.deepEqual(usageSharingIssues({ enabled: true, name: 'Ada', email: 'ada@example.com' }), []);
  assert.deepEqual(usageSharingIssues({ enabled: true, name: ' ', email: 'ada@example.com' }), ['name-required']);
  assert.deepEqual(usageSharingIssues({ enabled: true, name: 'Ada', email: 'not-an-email' }), ['email-invalid']);
  assert.deepEqual(usageSharingIssues({ enabled: true }), ['name-required', 'email-invalid']);
});

test('disabling needs no identity', () => {
  assert.deepEqual(usageSharingIssues({ enabled: false }), []);
});
