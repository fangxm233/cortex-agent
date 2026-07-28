import { describe, it, expect } from 'vitest';
import { mConnTone, mConnPulse } from './m-connection';

describe('mConnTone', () => {
  it('connected → done (green pill)', () => {
    expect(mConnTone('connected')).toBe('done');
  });
  it('connecting and reconnecting → waiting (amber pill)', () => {
    expect(mConnTone('connecting')).toBe('waiting');
    expect(mConnTone('reconnecting')).toBe('waiting');
  });
  it('disconnected → failed (red pill)', () => {
    expect(mConnTone('disconnected')).toBe('failed');
  });
});

describe('mConnPulse', () => {
  it('pulses only while (re)connecting', () => {
    expect(mConnPulse('connecting')).toBe(true);
    expect(mConnPulse('reconnecting')).toBe(true);
    expect(mConnPulse('connected')).toBe(false);
    expect(mConnPulse('disconnected')).toBe(false);
  });
});
