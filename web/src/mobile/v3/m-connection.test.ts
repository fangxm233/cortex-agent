import { describe, it, expect } from 'vitest';
import { mConnTone, mConnPulse } from './m-connection';
import type { ConnectionStatus } from '@/features/connection/connection-status';

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
  it('covers every status', () => {
    const all: ConnectionStatus[] = ['connecting', 'connected', 'reconnecting', 'disconnected'];
    for (const s of all) expect(['done', 'waiting', 'failed']).toContain(mConnTone(s));
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
