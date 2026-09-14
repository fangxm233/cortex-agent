//
// Evidence for the RunRequest-builder migration (plan §1.5 / T1.1): each `legacy*()` below is the
// hand-written literal copied verbatim out of `git show HEAD:agent-server/src/...` at the time of
// the migration, with the call site's own inputs turned into parameters. Every case asserts that
// the builder (plus whatever the call site spreads over it) is deep-equal to that literal, AND
// that the key sets of `context` / `policy` match exactly — `toEqual` treats an absent key and an
// `undefined` one as equal, and the difference between `threadId: null` and no `threadId` at all
// is load-bearing (see ask-user-resume's comment about CORTEX_THREAD_ID).
//
// `runId` is a fresh uuid per request, so it is normalized away before comparison and asserted
// separately.

import { describe, it, expect } from 'vitest';
import { DIRECT_RUN_POLICY, continuationRunRequest } from '../../src/domain/runs/builders.js';
import { bareSpec } from '../../src/domain/runs/spec-loader.js';
import type { RunRequest } from '../../src/domain/runs/request.js';
import type { ResolvedProfileConfig } from '../../src/domain/agents/profile-manager.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A stand-in for whatever `resolveRunProfile` / `resolveProfileConfig` / `resolveRunConfig`
 *  returns at the call site: the builder must pass it through by reference, untouched. */
function profile(name: string): ResolvedProfileConfig {
  return {
    name, model: 'sonnet', backend: 'claude', mode: null, provider: null,
    extraEnv: {}, extraOption: {}, claudeBackend: 'print', thinking: null,
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

// --- 1. orchestration/edit-retry.ts (runRetryAgent) ---

function legacyEditRetry(i: {
  sessionId: string | null; backendSessionId: string | null; channel: string;
  sessionName: string | null; profile: ResolvedProfileConfig; agentMessage: string; projectId: string;
}): RunRequest {
  return {
    runId: FIXED,
    session: {
      sessionId: i.sessionId,
      backendSessionId: i.backendSessionId,
      engineKey: i.channel,
      sessionName: i.sessionName,
    },
    profile: i.profile,
    spec: bareSpec(),
    prompt: { text: i.agentMessage, attachments: [] },
    context: {
      channel: i.channel,
      project: i.projectId,
      trigger: 'edit-retry',
      executionKind: 'local',
      isUserInitiated: true,
      commissionMode: false,
      commissionTools: false,
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

describe('continuationRunRequest — edit-retry', () => {
  it('matches the pre-migration literal field for field', () => {
    const p = profile('retry-profile');
    const input = {
      sessionId: 'sess-1', backendSessionId: 'backend-1', channel: 'slack:C1',
      sessionName: 'brave-otter', profile: p, agentMessage: 'edited text', projectId: 'cortex',
    };
    const built = continuationRunRequest({
      session: {
        sessionId: input.sessionId,
        backendSessionId: input.backendSessionId,
        engineKey: input.channel,
        sessionName: input.sessionName,
      },
      profile: p,
      prompt: input.agentMessage,
      channel: input.channel,
      project: input.projectId,
      trigger: 'edit-retry',
      isUserInitiated: true,
    });
    expectIdentical(built, legacyEditRetry(input));
  });

  it('carries null session ids through unchanged', () => {
    const p = profile('retry-profile');
    const input = {
      sessionId: null, backendSessionId: null, channel: 'web:abc',
      sessionName: null, profile: p, agentMessage: '', projectId: 'general',
    };
    const built = continuationRunRequest({
      session: { sessionId: null, backendSessionId: null, engineKey: input.channel, sessionName: null },
      profile: p, prompt: '', channel: input.channel, project: input.projectId,
      trigger: 'edit-retry', isUserInitiated: true,
    });
    expectIdentical(built, legacyEditRetry(input));
  });
});

// --- 2. orchestration/interactions/ask-user-resume.ts ---

function legacyAskUserResume(i: {
  sessionId: string; backendSessionId: string | null; channel: string;
  sessionName: string | null; profile: ResolvedProfileConfig; responseText: string; projectId: string;
}): RunRequest {
  return {
    runId: FIXED,
    session: {
      sessionId: i.sessionId,
      backendSessionId: i.backendSessionId,
      engineKey: i.channel,
      sessionName: i.sessionName,
    },
    profile: i.profile,
    spec: bareSpec(),
    prompt: { text: i.responseText, attachments: [] },
    context: {
      channel: i.channel,
      project: i.projectId,
      trigger: 'ask-user-question',
      threadId: null,
      executionKind: 'local',
      isUserInitiated: false,
      commissionMode: false,
      commissionTools: false,
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

describe('continuationRunRequest — ask-user-resume', () => {
  it('matches the pre-migration literal, including the explicit threadId: null', () => {
    const p = profile('ask-profile');
    const input = {
      sessionId: 'sess-ask', backendSessionId: 'backend-ask', channel: 'slack:C2',
      sessionName: 'quiet-fox', profile: p, responseText: 'the answer', projectId: 'general',
    };
    const base = continuationRunRequest({
      session: {
        sessionId: input.sessionId,
        backendSessionId: input.backendSessionId,
        engineKey: input.channel,
        sessionName: input.sessionName,
      },
      profile: p,
      prompt: input.responseText,
      channel: input.channel,
      project: input.projectId,
      trigger: 'ask-user-question',
    });
    const built: RunRequest = { ...base, context: { ...base.context, threadId: null } };
    expectIdentical(built, legacyAskUserResume(input));
    // The spread is what adds the key; the builder alone must not carry it.
    expect('threadId' in base.context).toBe(false);
  });
});

// --- 3. orchestration/status-helpers.ts (runAutoCompoundForScheduledTask) ---

function legacyAutoCompound(i: {
  baseSessionId: string | null; channel: string; profile: ResolvedProfileConfig;
  project: string | undefined; compoundTrigger: string;
}): RunRequest {
  return {
    runId: FIXED,
    session: {
      sessionId: i.baseSessionId || null,
      backendSessionId: i.baseSessionId || null,
      engineKey: i.channel,
      sessionName: null,
    },
    profile: i.profile,
    spec: bareSpec(),
    prompt: { text: '/compound-simple', attachments: [] },
    context: {
      channel: i.channel,
      project: i.project ?? 'general',
      trigger: i.compoundTrigger,
      executionKind: 'local',
      isUserInitiated: false,
      commissionMode: false,
      commissionTools: false,
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

describe('continuationRunRequest — auto-compound', () => {
  it('matches the pre-migration literal field for field', () => {
    const p = profile('compound-profile');
    const input = {
      baseSessionId: 'base-sess', channel: 'slack:C3', profile: p,
      project: 'wm-align', compoundTrigger: 'scheduled:compound',
    };
    const built = continuationRunRequest({
      session: {
        sessionId: input.baseSessionId || null,
        backendSessionId: input.baseSessionId || null,
        engineKey: input.channel,
        sessionName: null,
      },
      profile: p,
      prompt: '/compound-simple',
      channel: input.channel,
      project: input.project ?? 'general',
      trigger: input.compoundTrigger,
    });
    expectIdentical(built, legacyAutoCompound(input));
  });

  it('keeps the "" -> null session-id coercion and the general project default', () => {
    const p = profile('compound-profile');
    const input = {
      baseSessionId: '', channel: 'slack:C3', profile: p,
      project: undefined, compoundTrigger: 'auto-compound',
    };
    const built = continuationRunRequest({
      session: {
        sessionId: input.baseSessionId || null,
        backendSessionId: input.baseSessionId || null,
        engineKey: input.channel,
        sessionName: null,
      },
      profile: p,
      prompt: '/compound-simple',
      channel: input.channel,
      project: input.project ?? 'general',
      trigger: input.compoundTrigger,
    });
    expectIdentical(built, legacyAutoCompound(input));
  });
});

// --- 4. domain/sessions/session-hooks.ts (runHookInjection) ---

function legacySessionHookInjection(i: {
  targetSessionId: string; sessionKey: string; profile: ResolvedProfileConfig;
  output: string; channel: string; trigger: string;
}): RunRequest {
  return {
    runId: FIXED,
    session: {
      sessionId: i.targetSessionId,
      backendSessionId: i.targetSessionId,
      engineKey: i.sessionKey,
      sessionName: null,
    },
    profile: i.profile,
    spec: bareSpec(),
    prompt: { text: i.output, attachments: [] },
    context: {
      channel: i.channel,
      project: 'general',
      trigger: i.trigger,
      executionKind: 'local',
      isUserInitiated: false,
      commissionMode: false,
      commissionTools: false,
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

describe('continuationRunRequest — session-hook injection', () => {
  it('matches the pre-migration literal, keeping the isolated onNew pool key', () => {
    const p = profile('hook-profile');
    const input = {
      targetSessionId: 'old-sess', sessionKey: 'slack:C4::onnew-hook', profile: p,
      output: 'memory written', channel: 'slack:C4', trigger: 'hook:onNew',
    };
    const built = continuationRunRequest({
      session: {
        sessionId: input.targetSessionId,
        backendSessionId: input.targetSessionId,
        engineKey: input.sessionKey,
        sessionName: null,
      },
      profile: p,
      prompt: input.output,
      channel: input.channel,
      project: 'general',
      trigger: input.trigger,
    });
    expectIdentical(built, legacySessionHookInjection(input));
  });
});

// --- 5. domain/threads/hook-runner.ts (runHookAgent) ---

function legacyThreadHookAgent(i: {
  trackSessionId: string | null; sessionId: string | null; sessionKey: string;
  profile: ResolvedProfileConfig; prompt: string; channel: string; projectId: string;
  trigger: string; threadId: string; threadDepth: number; taskId: string | null;
  taskProject: string | null; taskGeneration: string | null; scheduleTaskId: string | null;
  executionKind: 'local' | 'dispatch' | 'scheduled'; background: 'inline' | 'none';
}): RunRequest {
  return {
    runId: FIXED,
    session: {
      sessionId: i.trackSessionId,
      backendSessionId: i.sessionId,
      engineKey: i.sessionKey,
      sessionName: null,
    },
    profile: i.profile,
    spec: bareSpec(),
    prompt: { text: i.prompt, attachments: [] },
    context: {
      channel: i.channel,
      project: i.projectId,
      trigger: i.trigger,
      threadId: i.threadId,
      threadDepth: i.threadDepth,
      taskId: i.taskId,
      taskProject: i.taskProject,
      taskGeneration: i.taskGeneration,
      scheduleTaskId: i.scheduleTaskId,
      executionKind: i.executionKind,
      isUserInitiated: false,
      commissionMode: false,
      commissionTools: false,
    },
    policy: {
      background: i.background,
      recordCost: true,
      hooks: true,
      loadRules: true,
      mcpComposition: 'direct',
      browserCdpEndpoint: null,
      captureTranscripts: true,
    },
  };
}

/** The migrated hook-runner shape: builder + the thread context block + the hook background
 *  policy, exactly as `src/domain/threads/hook-runner.ts` now writes it. */
function migratedThreadHookAgent(i: Parameters<typeof legacyThreadHookAgent>[0]): RunRequest {
  const base = continuationRunRequest({
    session: {
      sessionId: i.trackSessionId,
      backendSessionId: i.sessionId,
      engineKey: i.sessionKey,
      sessionName: null,
    },
    profile: i.profile,
    prompt: i.prompt,
    channel: i.channel,
    project: i.projectId,
    trigger: i.trigger,
    executionKind: i.executionKind,
  });
  return {
    ...base,
    context: {
      ...base.context,
      threadId: i.threadId,
      threadDepth: i.threadDepth,
      taskId: i.taskId,
      taskProject: i.taskProject,
      taskGeneration: i.taskGeneration,
      scheduleTaskId: i.scheduleTaskId,
    },
    policy: { ...base.policy, background: i.background },
  };
}

describe('continuationRunRequest — thread hook agent', () => {
  const dispatchCase = {
    trackSessionId: 'track-1', sessionId: 'backend-1', sessionKey: 'thr:T1:coder',
    profile: profile('thread-hook-profile'), prompt: 'DIRECTIVE\n\nprompt body',
    channel: 'slack:C5', projectId: 'cortex', trigger: 'task-dispatch', threadId: 'T1',
    threadDepth: 2, taskId: 'ab12', taskProject: 'cortex', taskGeneration: 'g3',
    scheduleTaskId: null, executionKind: 'dispatch' as const, background: 'inline' as const,
  };

  it('matches the pre-migration literal (dispatch thread, bgContinuation on)', () => {
    expectIdentical(migratedThreadHookAgent(dispatchCase), legacyThreadHookAgent(dispatchCase));
  });

  it('matches the pre-migration literal (insertAgent mode, bgContinuation off)', () => {
    const insertCase = {
      ...dispatchCase,
      trackSessionId: null, sessionId: null, sessionKey: 'thr:T2:hook:preStep',
      trigger: 'thread-hook', threadId: 'T2', threadDepth: 0,
      taskId: null, taskProject: null, taskGeneration: null, scheduleTaskId: 'sched-9',
      executionKind: 'scheduled' as const, background: 'none' as const,
    };
    expectIdentical(migratedThreadHookAgent(insertCase), legacyThreadHookAgent(insertCase));
  });

  it('overrides only background; the rest of the policy is the shared one', () => {
    const built = migratedThreadHookAgent(dispatchCase);
    expect(built.policy).toEqual({ ...DIRECT_RUN_POLICY, background: 'inline' });
    expect(built.policy).not.toBe(DIRECT_RUN_POLICY);
  });
});

// --- the shared constant itself ---

describe('DIRECT_RUN_POLICY', () => {
  it('is the policy block all five literals spelled out', () => {
    expect(DIRECT_RUN_POLICY).toEqual({
      background: 'none',
      recordCost: true,
      hooks: true,
      loadRules: true,
      mcpComposition: 'direct',
      browserCdpEndpoint: null,
      captureTranscripts: true,
    });
  });

  it('hands every request its own copy, so one call site cannot poison another', () => {
    const p = profile('x');
    const session = { sessionId: null, backendSessionId: null, engineKey: 'c', sessionName: null };
    const a = continuationRunRequest({ session, profile: p, prompt: 'a', channel: 'c', project: 'general', trigger: 't' });
    const b = continuationRunRequest({ session, profile: p, prompt: 'b', channel: 'c', project: 'general', trigger: 't' });
    expect(a.policy).not.toBe(b.policy);
    expect(a.policy).not.toBe(DIRECT_RUN_POLICY);
    expect(a.spec).not.toBe(b.spec);
    expect(a.runId).not.toBe(b.runId);
  });
});
