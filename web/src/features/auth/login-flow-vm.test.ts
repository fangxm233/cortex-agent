import { describe, expect, it } from 'vitest';
import type { LoginFlowState } from '@cortex-agent/ui-contract';
import { en } from '@/i18n/vocab';
import {
  buildLoginFlowVm,
  canSubmitPrompt,
  deviceCodeRemaining,
  expiredSnapshot,
  formatClock,
  newerSnapshot,
} from './login-flow-vm';

function state(overrides: Partial<LoginFlowState> = {}): LoginFlowState {
  return {
    flowId: 'flow-1', revision: 1, backend: 'pi', provider: 'deepseek', authType: 'api_key',
    step: 'running', pendingPrompt: null, notice: null, channel: null, sessionId: null,
    createdAt: '2030-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:30:00.000Z',
    outcome: null, error: null, errorCode: null,
    ...overrides,
  };
}

const vm = (input: Partial<Parameters<typeof buildLoginFlowVm>[0]>) => buildLoginFlowVm(
  { state: null, label: 'DeepSeek', startError: null, ...input }, en,
);

describe('newerSnapshot', () => {
  it('keeps the higher revision of one flow', () => {
    const older = state({ revision: 2 });
    const newer = state({ revision: 3, step: 'prompt' });
    expect(newerSnapshot(older, newer)).toBe(newer);
    expect(newerSnapshot(newer, older)).toBe(newer);
    expect(newerSnapshot(null, older)).toBe(older);
  });

  it('ignores a snapshot of another flow', () => {
    const current = state();
    expect(newerSnapshot(current, state({ flowId: 'flow-2', revision: 9 }))).toBe(current);
  });

  it('marks a vanished flow as expired', () => {
    expect(expiredSnapshot(state())).toMatchObject({ step: 'failed', errorCode: 'flow_not_found', revision: 2 });
  });
});

describe('buildLoginFlowVm', () => {
  it('starts in a starting view and shows a refused start as a failure', () => {
    expect(vm({})).toMatchObject({ kind: 'starting' });
    expect(vm({ startError: 'busy' })).toMatchObject({ kind: 'failed', detail: 'busy' });
  });

  it('uses the server prompt text verbatim', () => {
    const prompt = state({ step: 'prompt', pendingPrompt: { id: 1, kind: 'secret', message: 'Enter Amazon Bedrock bearer token' } });
    expect(vm({ state: prompt })).toEqual({ kind: 'prompt', message: 'Enter Amazon Bedrock bearer token' });
  });

  it.each(['info', 'auth_url', 'device_code', 'progress'] as const)('maps a running %s notice to the notice view', (kind) => {
    const notice = kind === 'info' ? { kind, message: 'Info' }
      : kind === 'auth_url' ? { kind, url: 'https://login.example.test' }
        : kind === 'device_code' ? { kind, userCode: 'CODE', verificationUri: 'https://verify.example.test' }
          : { kind, message: 'Working' };
    expect(vm({ state: state({ notice }) })).toMatchObject({ kind: 'notice' });
  });

  it('names the provider by label when done and keeps the upstream reason on failure', () => {
    expect(vm({ state: state({ step: 'done' }) }).message).toBe('Logged in to DeepSeek.');
    expect(vm({ state: state({ step: 'failed', error: 'PI OAuth login failed: State mismatch' }) }))
      .toEqual({ kind: 'failed', message: 'Login failed', detail: 'PI OAuth login failed: State mismatch' });
    expect(vm({ state: state({ step: 'failed', errorCode: 'flow_not_found' }) }).detail).toBe(en.authLoginExpired);
    expect(vm({ state: state({ step: 'cancelled' }) })).toMatchObject({ kind: 'cancelled' });
  });
});

describe('prompt answers', () => {
  it('lets only text prompts go empty', () => {
    expect(canSubmitPrompt({ id: 1, kind: 'text', message: 'Press Enter' }, '')).toBe(true);
    expect(canSubmitPrompt({ id: 1, kind: 'secret', message: 'Key' }, '  ')).toBe(false);
    expect(canSubmitPrompt({ id: 1, kind: 'manual_code', message: 'Code' }, '')).toBe(false);
    expect(canSubmitPrompt({ id: 1, kind: 'select', message: 'Pick', options: [{ id: 'a', label: 'A' }] }, 'a')).toBe(true);
    expect(canSubmitPrompt({ id: 1, kind: 'select', message: 'Pick', options: [{ id: 'a', label: 'A' }] }, 'b')).toBe(false);
  });

  it('counts device codes down in m:ss', () => {
    expect(deviceCodeRemaining(900, 1_000, 62_000)).toBe(839);
    expect(deviceCodeRemaining(10, 0, 60_000)).toBe(0);
    expect(formatClock(839)).toBe('13:59');
  });
});
