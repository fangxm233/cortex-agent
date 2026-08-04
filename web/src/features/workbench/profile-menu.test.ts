// input:  Claude/PI profile fixtures and profile-menu view model
// output: Profile labels, filtering, and switch-gating assertions
// pos:    Workbench profile menu regression tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, it, expect } from 'vitest';
import type { ConfigProfileEntry } from '@cortex-agent/ui-contract';
import { buildProfileOptions, currentBackendOf } from './profile-menu';

// The settings-editor fields (provider / claudeBackend / extraOption / extraEnvKeys / fallbackCount)
// play no part in the menu, so the factory supplies their empty shape and the fixtures stay readable.
function profile(over: Partial<ConfigProfileEntry> & Pick<ConfigProfileEntry, 'name'>): ConfigProfileEntry {
  return {
    model: null, backend: null, mode: null, thinking: null,
    provider: null, claudeBackend: null, extraOption: {}, extraEnvKeys: [], fallbackCount: 0,
    ...over,
  };
}

const profiles: ConfigProfileEntry[] = [
  profile({ name: 'plan', model: 'claude-opus-4-8', backend: 'claude', mode: 'plan', thinking: 'high' }),
  profile({ name: 'execute', model: 'claude-sonnet-4-6', backend: 'claude', mode: 'plan' }),
  profile({ name: 'gpt-execute', model: 'gpt-5.4', backend: 'pi', mode: 'openai-codex' }),
  profile({ name: 'deepseek-pro', model: 'deepseek-v4-pro', backend: 'pi', mode: 'deepseek', thinking: 'medium' }),
];

describe('buildProfileOptions', () => {
  it('builds options from the real profiles with model sub-labels and marks the active one', () => {
    const opts = buildProfileOptions(profiles, 'plan', { currentBackend: 'claude', hasHistory: false });
    expect(opts.map((o) => o.name)).toEqual(['plan', 'execute', 'gpt-execute', 'deepseek-pro']);
    // sub-label carries the thinking level (between model and backend) when the profile declares one
    expect(opts.find((o) => o.name === 'plan')).toMatchObject({ active: true, sub: 'claude-opus-4-8 · high · claude', backend: 'claude' });
    // no thinking → sub-label is just model · backend
    expect(opts.find((o) => o.name === 'execute')!.sub).toBe('claude-sonnet-4-6 · claude');
    expect(opts.filter((o) => o.active).map((o) => o.name)).toEqual(['plan']);
  });

  it('a fresh session (no history) disables nothing — any backend is selectable', () => {
    const opts = buildProfileOptions(profiles, 'plan', { currentBackend: 'claude', hasHistory: false });
    expect(opts.every((o) => !o.disabled)).toBe(true);
  });

  it('a live session (has history) disables cross-backend profiles only', () => {
    const opts = buildProfileOptions(profiles, 'plan', { currentBackend: 'claude', hasHistory: true });
    expect(opts.find((o) => o.name === 'execute')!.disabled).toBe(false); // same backend
    expect(opts.find((o) => o.name === 'gpt-execute')!.disabled).toBe(true); // cross backend
    expect(opts.find((o) => o.name === 'deepseek-pro')!.disabled).toBe(true); // cross backend
  });

  it('does not disable when the current backend is unknown (defensive)', () => {
    const opts = buildProfileOptions(profiles, 'plan', { currentBackend: null, hasHistory: true });
    expect(opts.every((o) => !o.disabled)).toBe(true);
  });

  it('omits a stale persisted Codex profile that reaches the client boundary', () => {
    const staleProfiles = [
      ...profiles,
      { name: 'legacy-codex', model: 'gpt-old', backend: 'codex', mode: 'plan', thinking: null } as unknown as ConfigProfileEntry,
    ];

    const opts = buildProfileOptions(staleProfiles, 'plan', { currentBackend: 'claude', hasHistory: false });

    expect(opts.map((option) => option.name)).not.toContain('legacy-codex');
  });
});

describe('currentBackendOf', () => {
  it('returns the active profile backend', () => {
    expect(currentBackendOf(profiles, 'gpt-execute')).toBe('pi');
    expect(currentBackendOf(profiles, 'plan')).toBe('claude');
  });
  it('returns null for an unknown or unsupported active profile', () => {
    const staleProfiles = [
      ...profiles,
      { name: 'legacy-codex', model: 'gpt-old', backend: 'codex', mode: 'plan', thinking: null } as unknown as ConfigProfileEntry,
    ];

    expect(currentBackendOf(profiles, 'ghost')).toBeNull();
    expect(currentBackendOf(staleProfiles, 'legacy-codex')).toBeNull();
  });
});
