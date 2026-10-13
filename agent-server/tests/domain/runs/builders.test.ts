//
// Evidence for the RunRequest-builder migration (plan §1.5 / T1.1): each `legacy*()` below is the
// hand-written literal copied verbatim out of `git show HEAD:agent-server/src/...` at the time of
// the migration, with the call site's own inputs turned into parameters. Every case asserts that
// the builder (plus whatever the call site spreads over it) is deep-equal to that literal, AND
// that the key sets of `context` / `policy` match exactly — `toEqual` treats an absent key and an
// `undefined` one as equal.
//
// `runId` is a fresh uuid per request, so it is normalized away before comparison and asserted
// separately.

import { describe, it, expect } from 'vitest';
import { DIRECT_RUN_POLICY, continuationRunRequest } from '../../../src/domain/runs/builders.js';
import { bareSpec } from '../../../src/domain/runs/spec-loader.js';
import type { RunRequest } from '../../../src/domain/runs/request.js';
import type { ResolvedProfileConfig } from '../../../src/domain/agents/profile-manager.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A stand-in for whatever `resolveRunProfile` / `resolveProfileConfig` / `resolveRunConfig`
 *  returns at the call site: the builder must pass it through by reference, untouched. */
function profile(name: string): ResolvedProfileConfig {
  return {
    name, model: 'sonnet', backend: 'claude', mode: null, provider: null,
    extraEnv: {}, extraOption: {}, thinking: null,
    maxOutputTokens: null, fallback: [],
  } as ResolvedProfileConfig;
}

const FIXED = '00000000-0000-4000-8000-000000000000';
function normalizeRunId(r: RunRequest): RunRequest {
  return { ...r, runId: FIXED };
}

/** `toEqual` ignores `undefined`-valued keys; these two make key PRESENCE part of the evidence. */
function expectSameShape(built: RunRequest, legacy: RunRequest): void {
  expect(Object.keys(built).sort()).toEqual(Object.keys(legacy).sort());
  expect(Object.keys(built.context).sort()).toEqual(Object.keys(legacy.context).sort());
  expect(Object.keys(built.policy).sort()).toEqual(Object.keys(legacy.policy).sort());
  expect(Object.keys(built.session).sort()).toEqual(Object.keys(legacy.session).sort());
}

function expectIdentical(built: RunRequest, legacy: RunRequest): void {
  expect(built.runId).toMatch(UUID_RE);
  expect(normalizeRunId(built)).toEqual(normalizeRunId(legacy));
  expectSameShape(built, legacy);
  // The profile is passed through, not rebuilt.
  expect(built.profile).toBe(legacy.profile);
}

// --- domain/sessions/session-hooks.ts (the onNew pre-close turn) ---

function legacyContinuation(i: {
  sessionId: string; backendSessionId: string | null; channel: string;
  profile: ResolvedProfileConfig; responseText: string; projectId: string;
}): RunRequest {
  return {
    runId: FIXED,
    session: {
      sessionId: i.sessionId,
      backendSessionId: i.backendSessionId,
      engineKey: i.channel,
      },
    profile: i.profile,
    spec: bareSpec(),
    prompt: { text: i.responseText, attachments: [] },
    context: {
      channel: i.channel,
      project: i.projectId,
      trigger: 'ask-user-question',
      executionKind: 'local',
      isUserInitiated: false,
      commissionMode: false,
      scheduleTaskId: null,
    },
    policy: {
      background: 'none',
      recordCost: true,
      hooks: true,
      loadRules: true,
      mcpComposition: 'direct',
      browserCdpEndpoint: null,
      captureTranscripts: true,
    },
  };
}

describe('continuationRunRequest', () => {
  it('matches the pre-migration literal', () => {
    const p = profile('ask-profile');
    const input = {
      sessionId: 'sess-ask', backendSessionId: 'backend-ask', channel: 'slack:C2',
      profile: p, responseText: 'the answer', projectId: 'general',
    };
    const base = continuationRunRequest({
      session: {
        sessionId: input.sessionId,
        backendSessionId: input.backendSessionId,
        engineKey: input.channel,
        },
      profile: p,
      prompt: input.responseText,
      channel: input.channel,
      project: input.projectId,
      trigger: 'ask-user-question',
    });
    expectIdentical(base, legacyContinuation(input));
  });
});

// --- the shared constant itself ---

describe('DIRECT_RUN_POLICY', () => {

  it('hands every request its own copy, so one call site cannot poison another', () => {
    const p = profile('x');
    const session = { sessionId: null, backendSessionId: null, engineKey: 'c'};
    const a = continuationRunRequest({ session, profile: p, prompt: 'a', channel: 'c', project: 'general', trigger: 't' });
    const b = continuationRunRequest({ session, profile: p, prompt: 'b', channel: 'c', project: 'general', trigger: 't' });
    expect(a.policy).not.toBe(b.policy);
    expect(a.policy).not.toBe(DIRECT_RUN_POLICY);
    expect(a.spec).not.toBe(b.spec);
    expect(a.runId).not.toBe(b.runId);
  });
});
