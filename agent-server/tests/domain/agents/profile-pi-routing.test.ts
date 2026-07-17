// input:  Node test runner + domain/agents/profile-manager + domain/agents/facade
// output: Lock down PI routing layering — profile carries logical `mode` + optional `provider`;
//         the gateway sub-path `/m/<mode>/<provider>` is derived in code, not stored in the profile.
// pos:    PI per-provider gateway routing — decouple gateway route (mode) from PI protocol (provider)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';

import { validateProfilesFile } from '../../../src/domain/agents/profile-manager.js';
import { buildPiGatewaySubPath } from '../../../src/domain/agents/facade.js';

// --- provider is REQUIRED for pi backend (explicit, no default, no fallback) ---

test('validateProfilesFile accepts a pi profile with an explicit provider', () => {
  assert.doesNotThrow(() => validateProfilesFile({
    defaultProfile: 'd',
    profiles: { d: { model: 'm', backend: 'pi', mode: 'anthropic', provider: 'anthropic' } },
  }));
});

test('validateProfilesFile rejects a pi profile that omits provider (no default)', () => {
  assert.throws(() => validateProfilesFile({
    defaultProfile: 'd',
    profiles: { d: { model: 'm', backend: 'pi', mode: 'anthropic' } },
  }), /provider/);
});

test('validateProfilesFile rejects a pi fallback that omits provider (no inheritance)', () => {
  assert.throws(() => validateProfilesFile({
    defaultProfile: 'd',
    profiles: {
      d: { model: 'm', backend: 'pi', mode: 'anthropic', provider: 'anthropic',
           fallback: [{ model: 'm2', mode: 'anthropic' }] },
    },
  }), /provider/);
});

test('validateProfilesFile does NOT require provider for non-pi backends', () => {
  assert.doesNotThrow(() => validateProfilesFile({
    defaultProfile: 'd',
    profiles: { d: { model: 'm', backend: 'claude', mode: 'plan' } },
  }));
});

test('validateProfilesFile rejects a non-string provider', () => {
  assert.throws(() => validateProfilesFile({
    defaultProfile: 'd',
    profiles: { d: { model: 'm', backend: 'pi', mode: 'anthropic', provider: 123 as any } },
  }), /provider/);
});

test('validateProfilesFile rejects a provider with unsafe characters', () => {
  assert.throws(() => validateProfilesFile({
    defaultProfile: 'd',
    profiles: { d: { model: 'm', backend: 'pi', mode: 'anthropic', provider: 'has spaces' } },
  }), /provider/);
});

// --- buildPiGatewaySubPath: gateway URL convention /m/<mode>/<provider> ---

test('buildPiGatewaySubPath: composes /m/<mode>/<provider>', () => {
  assert.equal(buildPiGatewaySubPath('anthropic', 'anthropic'), '/m/anthropic/anthropic');
});

test('buildPiGatewaySubPath: distinct mode and provider compose independently', () => {
  assert.equal(buildPiGatewaySubPath('deepseek-relay', 'anthropic'), '/m/deepseek-relay/anthropic');
});

test('buildPiGatewaySubPath: returns undefined when mode is absent (fallback to default /<provider>)', () => {
  assert.equal(buildPiGatewaySubPath(null, 'anthropic'), undefined);
});
