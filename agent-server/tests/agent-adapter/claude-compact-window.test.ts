// input:  temporary Claude settings trees and config directories
// output: auto-compact window resolution regression tests
// pos:    Claude auto-compact window settings contract
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveAutoCompactWindow } from '../../src/agent-adapter/claude/compact-window.js';

interface Layout {
  local?: unknown;
  project?: unknown;
  user?: unknown;
}

function layout(files: Layout): { cwd: string; userConfigDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-compact-window-'));
  const cwd = path.join(root, 'cwd');
  const userConfigDir = path.join(root, 'user');
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  fs.mkdirSync(userConfigDir, { recursive: true });
  const write = (file: string, value: unknown) => {
    if (value !== undefined) fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  write(path.join(cwd, '.claude', 'settings.local.json'), files.local);
  write(path.join(cwd, '.claude', 'settings.json'), files.project);
  write(path.join(userConfigDir, 'settings.json'), files.user);
  return { cwd, userConfigDir };
}

describe('resolveAutoCompactWindow', () => {
  test('reads the user settings window when no project settings define one', () => {
    const { cwd, userConfigDir } = layout({ user: { autoCompactWindow: 350_000 } });
    assert.equal(resolveAutoCompactWindow(cwd, userConfigDir), 350_000);
  });

  test('prefers local project settings over project and user settings', () => {
    const { cwd, userConfigDir } = layout({
      local: { autoCompactWindow: 120_000 },
      project: { autoCompactWindow: 240_000 },
      user: { autoCompactWindow: 350_000 },
    });
    assert.equal(resolveAutoCompactWindow(cwd, userConfigDir), 120_000);
  });

  test('prefers project settings over user settings', () => {
    const { cwd, userConfigDir } = layout({
      project: { autoCompactWindow: 240_000 },
      user: { autoCompactWindow: 350_000 },
    });
    assert.equal(resolveAutoCompactWindow(cwd, userConfigDir), 240_000);
  });

  test('returns null when the setting is absent everywhere', () => {
    const { cwd, userConfigDir } = layout({ user: { model: 'claude-opus-5[1m]' } });
    assert.equal(resolveAutoCompactWindow(cwd, userConfigDir), null);
  });

  test('falls through out-of-range and non-integer values like the CLI schema', () => {
    for (const rejected of [99_999, 1_000_001, 350_000.5, '350000', null]) {
      const { cwd, userConfigDir } = layout({
        project: { autoCompactWindow: rejected },
        user: { autoCompactWindow: 350_000 },
      });
      assert.equal(resolveAutoCompactWindow(cwd, userConfigDir), 350_000, `rejected: ${String(rejected)}`);
    }
  });

  test('accepts the documented range boundaries', () => {
    const low = layout({ user: { autoCompactWindow: 100_000 } });
    const high = layout({ user: { autoCompactWindow: 1_000_000 } });
    assert.equal(resolveAutoCompactWindow(low.cwd, low.userConfigDir), 100_000);
    assert.equal(resolveAutoCompactWindow(high.cwd, high.userConfigDir), 1_000_000);
  });

  test('treats malformed and missing settings files as unset', () => {
    const { cwd, userConfigDir } = layout({ project: '{ not json', user: { autoCompactWindow: 350_000 } });
    assert.equal(resolveAutoCompactWindow(cwd, userConfigDir), 350_000);
    assert.equal(resolveAutoCompactWindow(path.join(cwd, 'missing'), path.join(userConfigDir, 'missing')), null);
  });
});
