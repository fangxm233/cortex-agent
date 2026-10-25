import { describe, expect, it } from 'vitest';
import type { TelemetryInfo } from '@cortex-agent/ui-contract';
import { buildPrivacyView } from './privacy-vm';

const ID = '0f8b5c1e-3a7d-4e2b-9c41-6d2a8e5f7b90';
const info = (patch: Partial<TelemetryInfo>): TelemetryInfo => ({
  settingEnabled: true, active: true, inactiveReason: null, installId: ID, ...patch,
});

describe('privacy view', () => {
  it('is an editable switch while only the setting decides', () => {
    expect(buildPrivacyView(info({}))).toEqual({ on: true, lockedReason: null, installId: ID });
    expect(buildPrivacyView(info({ settingEnabled: false, active: false, inactiveReason: 'setting' })))
      .toEqual({ on: false, lockedReason: null, installId: ID });
  });

  it.each([
    ['env', 'tmReasonEnv'], ['do-not-track', 'tmReasonDnt'], ['dev', 'tmReasonDev'],
    ['no-endpoint', 'tmReasonNoEndpoint'], ['sealed', 'tmReasonSealed'],
  ] as const)('is locked off with a reason when %s decides', (reason, key) => {
    expect(buildPrivacyView(info({ active: false, inactiveReason: reason }))).toMatchObject({ on: false, lockedReason: key });
  });

  it('is locked on when the environment overrides a disabled setting', () => {
    expect(buildPrivacyView(info({ settingEnabled: false }))).toMatchObject({ on: true, lockedReason: 'tmReasonEnv' });
  });
});
