// input:  LoginFlow metadata states and English vocabulary
// output: selection, prompt, notice, and terminal view-model regressions
// pos:    Tests the secret-free Web login state renderer
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import type { LoginFlowState } from '@cortex-agent/ui-contract';
import { en } from '@/i18n/vocab';
import { buildLoginFlowVm } from './login-flow-vm';

function state(overrides: Partial<LoginFlowState> = {}): LoginFlowState {
  return {
    flowId: 'flow-1', backend: 'claude', provider: 'anthropic', authType: 'api_key',
    step: 'running', pendingPrompt: null, notice: null, channel: null, sessionId: null,
    createdAt: '2030-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:30:00.000Z',
    outcome: null, error: null, errorCode: null,
    ...overrides,
  };
}

describe('buildLoginFlowVm', () => {
  it('uses a pre-flow selection view when no flow exists', () => {
    expect(buildLoginFlowVm(null, en)).toMatchObject({ kind: 'selection', terminal: false });
  });

  it.each([
    ['secret', 'password'],
    ['manual_code', 'password'],
    ['text', 'text'],
    ['select', 'select'],
  ] as const)('maps %s prompts to a %s control', (kind, inputType) => {
    const prompt = kind === 'select'
      ? { kind, message: 'Pick', options: [{ id: 'one', label: 'One' }] }
      : { kind, message: 'Enter' };
    const vm = buildLoginFlowVm(state({ step: 'prompt', pendingPrompt: prompt }), en);

    expect(vm).toMatchObject({ kind: 'prompt', inputType, terminal: false });
  });

  it.each(['info', 'auth_url', 'device_code', 'progress'] as const)(
    'renders %s notices without creating an input',
    (kind) => {
      const notice = kind === 'info'
        ? { kind, message: 'Info' }
        : kind === 'auth_url'
          ? { kind, url: 'https://login.example.test', instructions: 'Open' }
          : kind === 'device_code'
            ? { kind, userCode: 'CODE', verificationUri: 'https://verify.example.test' }
            : { kind, message: 'Working' };
      expect(buildLoginFlowVm(state({ notice }), en)).toMatchObject({
        kind: 'notice', inputType: null, terminal: false,
      });
    },
  );

  it('maps done and failed states to localized terminal summaries', () => {
    const done = buildLoginFlowVm(state({
      step: 'done',
      outcome: { provider: 'anthropic', authType: 'api_key', expiresAt: null },
    }), en);
    const failed = buildLoginFlowVm(state({
      step: 'failed', error: 'PI runtime is unavailable.', errorCode: 'runtime_unavailable',
    }), en);

    expect(done).toMatchObject({ kind: 'done', terminal: true });
    expect(done.message).toContain('anthropic');
    expect(failed).toMatchObject({ kind: 'failed', terminal: true });
    expect(failed.message).toContain('PI runtime is unavailable.');
  });
});
