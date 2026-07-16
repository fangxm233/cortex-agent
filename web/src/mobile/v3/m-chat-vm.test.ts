import { describe, it, expect } from 'vitest';
import type { ConfigProfileEntry } from '@cortex-agent/ui-contract';
import {
  chatHeaderStatus,
  effectiveProfileName,
  profileChipLabel,
  profileSub,
  buildProfileSheetItems,
  formatTtl,
} from './m-chat-vm';

const profiles: ConfigProfileEntry[] = [
  { name: 'default', model: 'sonnet-4.5', backend: 'anthropic', mode: null },
  { name: 'cheap', model: 'haiku-4', backend: 'anthropic', mode: null },
  { name: 'deep', model: 'opus-4.5', backend: 'bedrock', mode: null },
];

describe('chatHeaderStatus', () => {
  it('running with a real turn count → `running · N turns` (no cost)', () => {
    const s = chatHeaderStatus(true, 12);
    expect(s.running).toBe(true);
    expect(s.text).toBe('running · 12 turns');
    expect(s.text).not.toContain('$');
  });
  it('running with unknown turns → bare `running`', () => {
    expect(chatHeaderStatus(true, null).text).toBe('running');
  });
  it('idle with a real turn count → `idle · N turns`', () => {
    expect(chatHeaderStatus(false, 12).text).toBe('idle · 12 turns');
  });
  it('idle with unknown turns → bare `idle`', () => {
    expect(chatHeaderStatus(false, null).text).toBe('idle');
  });
});

describe('effectiveProfileName', () => {
  it('prefers the session profile', () => {
    expect(effectiveProfileName('cheap', profiles, 'default')).toBe('cheap');
  });
  it('falls back to the config default, then the first profile, then —', () => {
    expect(effectiveProfileName(null, profiles, 'default')).toBe('default');
    expect(effectiveProfileName(null, profiles, null)).toBe('default');
    expect(effectiveProfileName(null, [], null)).toBe('—');
  });
});

describe('profileChipLabel', () => {
  it('renders `name · model`', () => {
    expect(profileChipLabel('default', profiles)).toBe('default · sonnet-4.5');
  });
  it('falls back to backend when model is null, then to bare name', () => {
    expect(profileChipLabel('x', [{ name: 'x', model: null, backend: 'anthropic', mode: null }])).toBe('x · anthropic');
    expect(profileChipLabel('x', [{ name: 'x', model: null, backend: null, mode: null }])).toBe('x');
    expect(profileChipLabel('missing', profiles)).toBe('missing');
  });
});

describe('profileSub / buildProfileSheetItems', () => {
  it('renders `model · backend`, dropping a missing half', () => {
    expect(profileSub(profiles[0])).toBe('sonnet-4.5 · anthropic');
    expect(profileSub({ name: 'x', model: null, backend: 'anthropic', mode: null })).toBe('anthropic');
    expect(profileSub({ name: 'x', model: 'm', backend: null, mode: null })).toBe('m');
  });
  it('marks the current profile', () => {
    const items = buildProfileSheetItems(profiles, 'cheap');
    expect(items.map((i) => i.name)).toEqual(['default', 'cheap', 'deep']);
    expect(items.find((i) => i.current)?.name).toBe('cheap');
    expect(items.filter((i) => i.current)).toHaveLength(1);
  });
});

describe('formatTtl', () => {
  it('formats MM:SS and clamps at 0', () => {
    expect(formatTtl(1754)).toBe('29:14');
    expect(formatTtl(9)).toBe('00:09');
    expect(formatTtl(-5)).toBe('00:00');
  });
});
