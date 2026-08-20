import { describe, it, expect } from 'vitest';
import {
  deriveConnectionStatus,
} from './connection-status';

describe('deriveConnectionStatus', () => {
  it('pending → connected (regardless of history)', () => {
    expect(deriveConnectionStatus('pending', false)).toBe('connected');
    expect(deriveConnectionStatus('pending', true)).toBe('connected');
  });

  it('connecting before ever connecting → connecting (initial approach, not alarming)', () => {
    expect(deriveConnectionStatus('connecting', false)).toBe('connecting');
  });

  it('connecting after a prior connection → reconnecting', () => {
    expect(deriveConnectionStatus('connecting', true)).toBe('reconnecting');
  });

  it('idle after a prior connection → disconnected', () => {
    expect(deriveConnectionStatus('idle', true)).toBe('disconnected');
  });

  it('idle before ever connecting → connecting (never scary on first paint)', () => {
    expect(deriveConnectionStatus('idle', false)).toBe('connecting');
  });
});
