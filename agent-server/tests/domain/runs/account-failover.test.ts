// Account failover picks the next free login of the same provider and billing, in registry order
// with the default first; never a key connection; nothing at all while the switch is off.
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineSelection } from '../../../src/domain/agents/engine-selection.js';
import {
  _resetFailoverAnnouncements, announceFailover, failoverCandidate, preflightFailover, resumeFailover,
  type FailoverDeps,
} from '../../../src/domain/runs/account-failover.js';

const claude = (connection: string | null): EngineSelection => ({
  backend: 'claude', provider: null, model: 'claude-opus-4-7', thinking: null, connection,
});
const pi = (connection: string | null): EngineSelection => ({
  backend: 'pi', provider: 'openai-codex', model: 'gpt-5.5', thinking: null, connection,
});

function deps(overrides: Partial<FailoverDeps> & { limited?: string[]; metered?: string[] } = {}): FailoverDeps {
  const limited = new Set(overrides.limited ?? []);
  const metered = new Set(overrides.metered ?? []);
  const route = (selection: EngineSelection) => selection.connection ?? selection.provider ?? '';
  return {
    enabled: () => true,
    logins: (selection) => (selection.backend === 'claude' ? ['subscription', 'school', 'lab'] : [null, 'codex-lab']),
    billingOf: (ref) => (metered.has(ref.connection ?? '') ? 'metered' : 'subscription'),
    isRateLimited: (selection) => limited.has(route(selection)),
    ...overrides,
  };
}

afterEach(() => _resetFailoverAnnouncements());

describe('the failover candidate', () => {
  it('is the first other free login billed the same way, the default first', () => {
    expect(failoverCandidate(claude('school'), deps())?.to).toBe('subscription');
    expect(failoverCandidate(claude('subscription'), deps({ limited: ['school'] }))?.to).toBe('lab');
    expect(failoverCandidate(claude('subscription'), deps({ metered: ['school'] }))?.to).toBe('lab');
    expect(failoverCandidate(claude('subscription'), deps({ limited: ['school', 'lab'] }))).toBeNull();
  });

  it('keeps everything but the connection of the session\'s selection', () => {
    const target = failoverCandidate(claude('subscription'), deps());
    expect(target).toEqual({ selection: claude('school'), from: 'subscription', to: 'school' });
  });

  it('runs a PI provider\'s default login as a null connection', () => {
    expect(failoverCandidate(pi('codex-lab'), deps())?.selection.connection).toBeNull();
    expect(failoverCandidate(pi(null), deps())).toMatchObject({ from: 'openai-codex', to: 'codex-lab' });
  });

  it('never leaves a selection that is not on one of the provider\'s logins', () => {
    expect(failoverCandidate(claude('qwen-ksu'), deps())).toBeNull();
  });

  it('is nothing while the switch is off', () => {
    expect(failoverCandidate(claude('subscription'), deps({ enabled: () => false }))).toBeNull();
    expect(preflightFailover(claude('subscription'), deps({ enabled: () => false, limited: ['subscription'] }))).toBeNull();
  });
});

describe('when failover applies', () => {
  it('before a run: only while the selection\'s own login is limited', () => {
    expect(preflightFailover(claude('subscription'), deps())).toBeNull();
    expect(preflightFailover(claude('subscription'), deps({ limited: ['subscription'] }))?.to).toBe('school');
  });

  it('after a limit: only when the run was on the session\'s own login, so it switches once', () => {
    const d = deps({ limited: ['subscription'] });
    expect(resumeFailover(claude('subscription'), { provider: 'anthropic', route: 'subscription' }, d)?.to).toBe('school');
    expect(resumeFailover(claude('subscription'), { provider: 'anthropic', route: 'school' }, d)).toBeNull();
    expect(resumeFailover(pi(null), { provider: 'openai-codex', route: 'openai-codex' }, deps({ limited: ['openai-codex'] }))?.to)
      .toBe('codex-lab');
  });

  it('is announced on the first run of a switch only, and again after going back', () => {
    const target = failoverCandidate(claude('subscription'), deps())!;
    expect(announceFailover('web:a', target)).toBe(true);
    expect(announceFailover('web:a', target)).toBe(false);
    expect(announceFailover('web:b', target)).toBe(true);
    expect(announceFailover('web:a', null)).toBe(false);
    expect(announceFailover('web:a', target)).toBe(true);
  });
});
