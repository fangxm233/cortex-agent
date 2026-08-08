// input:  the settings a trial pins, captured once from the host settings boundary
// output: SettingsSnapshot — key reads over a frozen record, with no reload path
// pos:    §7.2 P23. Compile-time settings port for the composite path
// >>> If I am updated, update my header and folder CORTEX.md <<<
//
// The shipped settings object is file-backed and hot-reloading (core/settings.ts:41,
// SETTINGS_FILE:31), and two composite behaviours read it live at decision time: the manager
// rotation threshold (orchestration/thread-callback.ts:185-187) and the waiting-sweep cadence
// (:703). A trial whose rotation threshold can change mid-run is not reproducible, so the trial
// reads a frozen record instead. This module deliberately does NOT subscribe to `onSettingsChange`
// and does NOT read the file itself: `captureSettingsSnapshot` calls `getSettings()` exactly once
// and everything after that is a lookup in a frozen object.

import { getSettings, type SettingKey, type Settings } from '../../core/settings.js';

export interface SettingsSnapshot {
  /** Throws for a key absent from the snapshot; there is no default and no fallback read. */
  get<K extends SettingKey>(key: K): Settings[K];
  has(key: SettingKey): boolean;
  keys(): readonly SettingKey[];
  readonly record: Readonly<Partial<Settings>>;
}

export function createSettingsSnapshot(source: Readonly<Partial<Settings>>): SettingsSnapshot {
  const record = Object.freeze({ ...source });
  const keys = Object.freeze(Object.keys(record) as SettingKey[]);
  return {
    record,
    keys: () => keys,
    has: key => Object.hasOwn(record, key),
    get<K extends SettingKey>(key: K): Settings[K] {
      if (!Object.hasOwn(record, key)) {
        throw new TypeError(`Setting absent from the trial snapshot: ${key}`);
      }
      return record[key] as Settings[K];
    },
  };
}

/** The one host read. Called at policy compile time, never inside the trial. */
export function captureSettingsSnapshot(): SettingsSnapshot {
  return createSettingsSnapshot(getSettings());
}
