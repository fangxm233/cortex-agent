import { describe, expect, it, vi } from 'vitest';

import {
  captureSettingsSnapshot, createSettingsSnapshot,
} from '../../../src/domain/benchmark/settings-snapshot.js';
import * as settingsModule from '../../../src/core/settings.js';

describe('SettingsSnapshot (§7.2 P23)', () => {
  it('reads a captured key from the frozen record', () => {
    const snapshot = createSettingsSnapshot({ managerRotateSteps: 12 });
    expect(snapshot.get('managerRotateSteps')).toBe(12);
  });

  it('throws for a key absent from the snapshot rather than returning undefined', () => {
    const snapshot = createSettingsSnapshot({ managerRotateSteps: 12 });
    expect(() => snapshot.get('autoResume')).toThrow(TypeError);
  });

  it('reports the exact key set it captured', () => {
    const snapshot = createSettingsSnapshot({ managerRotateSteps: 12, autoResume: true });
    expect([...snapshot.keys()].sort()).toEqual(['autoResume', 'managerRotateSteps']);
    expect(snapshot.has('autoResume')).toBe(true);
    expect(snapshot.has('turnNotify')).toBe(false);
  });

  it('freezes the captured record, so a later write cannot move a trial mid-run', () => {
    const source = { managerRotateSteps: 12 };
    const snapshot = createSettingsSnapshot(source);
    source.managerRotateSteps = 99;
    expect(snapshot.get('managerRotateSteps')).toBe(12);
    expect(Object.isFrozen(snapshot.record)).toBe(true);
    expect(() => {
      (snapshot.record as { managerRotateSteps: number }).managerRotateSteps = 77;
    }).toThrow(TypeError);
  });

  it('captures getSettings() exactly once and never reads it again', () => {
    const live = { ...settingsModule.getSettings() };
    const read = vi.spyOn(settingsModule, 'getSettings').mockImplementation(() => live as never);
    try {
      const snapshot = captureSettingsSnapshot();
      expect(read).toHaveBeenCalledTimes(1);
      snapshot.get('managerRotateSteps');
      snapshot.get('managerRotateSteps');
      snapshot.has('autoResume');
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      read.mockRestore();
    }
  });

  it('does not observe a settings change made after the capture', () => {
    const live: Record<string, unknown> = { managerRotateSteps: 5 };
    const read = vi.spyOn(settingsModule, 'getSettings').mockImplementation(() => live as never);
    try {
      const snapshot = captureSettingsSnapshot();
      live.managerRotateSteps = 500;
      expect(snapshot.get('managerRotateSteps')).toBe(5);
    } finally {
      read.mockRestore();
    }
  });

  it('imports only getSettings — no filesystem, no reload subscription', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(
      new URL('../../../src/domain/benchmark/settings-snapshot.ts', import.meta.url), 'utf8',
    );
    const imported = [...source.matchAll(/^import\s+\{([^}]*)\}/gm)]
      .flatMap(match => match[1].split(','))
      .map(name => name.replace(/^\s*type\s+/, '').trim())
      .filter(Boolean);
    expect(imported.sort()).toEqual(['SettingKey', 'Settings', 'getSettings']);
    expect(source).not.toMatch(/^import[^\n]*node:/m);
  });
});
