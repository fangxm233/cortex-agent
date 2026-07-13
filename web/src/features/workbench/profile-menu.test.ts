import { describe, it, expect } from 'vitest';
import type { ConfigProfileEntry } from '@cortex-agent/ui-contract';
import { buildProfileOptions, currentBackendOf } from './profile-menu';

const profiles: ConfigProfileEntry[] = [
  { name: 'plan', model: 'claude-opus-4-8', backend: 'claude', mode: 'plan' },
  { name: 'execute', model: 'claude-sonnet-4-6', backend: 'claude', mode: 'plan' },
  { name: 'codex', model: 'gpt-5.4', backend: 'codex', mode: 'plan' },
  { name: 'deepseek-pro', model: 'deepseek-v4-pro', backend: 'pi', mode: 'deepseek' },
];

describe('buildProfileOptions', () => {
  it('builds options from the real profiles with model sub-labels and marks the active one', () => {
    const opts = buildProfileOptions(profiles, 'plan', { currentBackend: 'claude', hasHistory: false });
    expect(opts.map((o) => o.name)).toEqual(['plan', 'execute', 'codex', 'deepseek-pro']);
    expect(opts.find((o) => o.name === 'plan')).toMatchObject({ active: true, sub: 'claude-opus-4-8 · claude', backend: 'claude' });
    expect(opts.filter((o) => o.active).map((o) => o.name)).toEqual(['plan']);
  });

  it('a fresh session (no history) disables nothing — any backend is selectable', () => {
    const opts = buildProfileOptions(profiles, 'plan', { currentBackend: 'claude', hasHistory: false });
    expect(opts.every((o) => !o.disabled)).toBe(true);
  });

  it('a live session (has history) disables cross-backend profiles only', () => {
    const opts = buildProfileOptions(profiles, 'plan', { currentBackend: 'claude', hasHistory: true });
    expect(opts.find((o) => o.name === 'execute')!.disabled).toBe(false); // same backend
    expect(opts.find((o) => o.name === 'codex')!.disabled).toBe(true); // cross backend
    expect(opts.find((o) => o.name === 'deepseek-pro')!.disabled).toBe(true); // cross backend
  });

  it('does not disable when the current backend is unknown (defensive)', () => {
    const opts = buildProfileOptions(profiles, 'plan', { currentBackend: null, hasHistory: true });
    expect(opts.every((o) => !o.disabled)).toBe(true);
  });
});

describe('currentBackendOf', () => {
  it('returns the active profile backend', () => {
    expect(currentBackendOf(profiles, 'codex')).toBe('codex');
    expect(currentBackendOf(profiles, 'plan')).toBe('claude');
  });
  it('returns null for an unknown active profile', () => {
    expect(currentBackendOf(profiles, 'ghost')).toBeNull();
  });
});
