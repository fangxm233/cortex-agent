// input:  Claude/PI profile fixtures and profile-menu view model
// output: Profile picker labels and switch-gating assertions
// pos:    Workbench profile menu regression tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, it, expect } from 'vitest';
import type { ConfigProfileEntry } from '@cortex-agent/ui-contract';
import { buildProfileOptions, currentBackendOf } from './profile-menu';

const profiles: ConfigProfileEntry[] = [
  { name: 'plan', model: 'claude-opus-4-8', backend: 'claude', mode: 'plan', thinking: 'high' },
  { name: 'execute', model: 'claude-sonnet-4-6', backend: 'claude', mode: 'plan', thinking: null },
  { name: 'gpt-execute', model: 'gpt-5.4', backend: 'pi', mode: 'openai-codex', thinking: null },
  { name: 'deepseek-pro', model: 'deepseek-v4-pro', backend: 'pi', mode: 'deepseek', thinking: 'medium' },
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
});

describe('currentBackendOf', () => {
  it('returns the active profile backend', () => {
    expect(currentBackendOf(profiles, 'gpt-execute')).toBe('pi');
    expect(currentBackendOf(profiles, 'plan')).toBe('claude');
  });
  it('returns null for an unknown active profile', () => {
    expect(currentBackendOf(profiles, 'ghost')).toBeNull();
  });
});
