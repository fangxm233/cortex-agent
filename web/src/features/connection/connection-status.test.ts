import { describe, it, expect } from 'vitest';
import {
  deriveConnectionStatus,
  connectionDot,
  connectionLabelKey,
  type ConnectionStatus,
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

describe('connectionDot', () => {
  it('connected is solid green, no pulse', () => {
    expect(connectionDot('connected')).toEqual({ color: 'var(--proto-success)', pulse: false });
  });

  it('connecting and reconnecting both pulse amber', () => {
    expect(connectionDot('connecting')).toEqual({ color: 'var(--proto-amber)', pulse: true });
    expect(connectionDot('reconnecting')).toEqual({ color: 'var(--proto-amber)', pulse: true });
  });

  it('disconnected is solid danger, no pulse', () => {
    expect(connectionDot('disconnected')).toEqual({ color: 'var(--proto-danger)', pulse: false });
  });

  it('covers every status', () => {
    const statuses: ConnectionStatus[] = ['connecting', 'connected', 'reconnecting', 'disconnected'];
    for (const s of statuses) {
      const dot = connectionDot(s);
      expect(typeof dot.color).toBe('string');
      expect(dot.color.startsWith('var(--')).toBe(true);
      expect(typeof dot.pulse).toBe('boolean');
    }
  });
});

describe('connectionLabelKey', () => {
  it('maps each status to its vocab key', () => {
    expect(connectionLabelKey('connected')).toBe('connConnected');
    expect(connectionLabelKey('connecting')).toBe('connConnecting');
    expect(connectionLabelKey('reconnecting')).toBe('connReconnecting');
    expect(connectionLabelKey('disconnected')).toBe('connDisconnected');
  });
});
