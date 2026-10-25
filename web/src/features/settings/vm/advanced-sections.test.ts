import { describe, expect, it } from 'vitest';
import type { ConfigSettingEntry } from '@cortex-agent/ui-contract';
import {
  ADVANCED_SECTIONS, advancedToggleState, visibleAdvancedRows, type AdvancedToggleRow,
} from './advanced-sections';
import { indexEnv, indexSettings } from './platform-env';

function toggleRow(setting: AdvancedToggleRow['setting']): AdvancedToggleRow {
  for (const section of ADVANCED_SECTIONS) {
    const row = section.rows.find((r) => r.kind === 'toggle' && r.setting === setting);
    if (row) return row as AdvancedToggleRow;
  }
  throw new Error(`no toggle row for ${setting}`);
}

const settings = (entries: Array<[ConfigSettingEntry['key'], boolean]>) =>
  indexSettings(entries.map(([key, value]) => ({ key, value, source: 'file' }) as ConfigSettingEntry));

describe('advanced toggle state', () => {
  it('shows a "disable" key as the feature it gates, and flips the stored value', () => {
    const row = toggleRow('disableUserContext');
    expect(advancedToggleState(row, settings([['disableUserContext', false]])))
      .toEqual({ on: true, next: true, editable: true });
    expect(advancedToggleState(row, settings([['disableUserContext', true]])))
      .toEqual({ on: false, next: false, editable: true });
  });

  it('locks automatic server installs while the update check is off', () => {
    const row = toggleRow('serverAutoUpdate');
    expect(advancedToggleState(row, settings([['serverAutoUpdate', true], ['serverUpdateDisable', true]])).editable)
      .toBe(false);
    expect(advancedToggleState(row, settings([['serverAutoUpdate', true], ['serverUpdateDisable', false]])).editable)
      .toBe(true);
  });

  it('cannot flip a setting the server has not reported', () => {
    expect(advancedToggleState(toggleRow('eventLog'), settings([])).editable).toBe(false);
  });
});

describe('advanced rows', () => {
  const diagnostics = ADVANCED_SECTIONS.find((section) => section.key === 'diagnostics')!;
  const envKeys = (env: Parameters<typeof indexEnv>[0]) => visibleAdvancedRows(diagnostics, indexEnv(env))
    .flatMap((row) => (row.kind === 'env' ? [row.env] : []));

  it('lists the GPU mock only while it is set', () => {
    expect(envKeys([])).toEqual(['DEBUG']);
    expect(envKeys([{ key: 'CORTEX_GPU_MONITOR_MOCK', present: true, masked: '••' }]))
      .toEqual(['DEBUG', 'CORTEX_GPU_MONITOR_MOCK']);
  });

  it('leaves the platform-only tool-call switch out of Advanced', () => {
    const toggles = ADVANCED_SECTIONS.flatMap((section) => section.rows)
      .flatMap((row) => (row.kind === 'toggle' ? [row.setting] : []));
    expect(toggles).not.toContain('showToolCalls');
  });
});
