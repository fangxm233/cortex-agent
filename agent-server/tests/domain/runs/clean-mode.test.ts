import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { cleanRunPolicy, cleanSettingSources } from '../../../src/domain/runs/clean-mode.js';
import { buildEngineSpec } from '../../../src/domain/runs/engine-spec.js';
import { claudeProcessLaunch, launchFromSpec } from '../../../src/agent-adapter/claude/session-options.js';
import { buildSessionRequest, PI_CLEAN_WORKSPACE_ENV, sessionIdentity } from '../../../src/agent-adapter/pi/session-options.js';
import { runRequestFixture, attemptFixture } from '../../run-request-fixture.js';
import type { RunRequest } from '../../../src/domain/runs/request.js';

const WORKSPACE = '/srv/workspaces/a1b2c3d4';

function cleanRequest(overrides: Partial<RunRequest['policy']> = {}): RunRequest {
  const request = runRequestFixture({ channel: 'web:clean', appendSystemPrompt: 'ROLE BODY' });
  return { ...request, cwd: WORKSPACE, policy: cleanRunPolicy({ ...request.policy, ...overrides }) };
}

test('clean setting sources drop only project; an agent that declared none keeps none', () => {
  assert.deepEqual(cleanSettingSources(undefined), ['user', 'local']);
  assert.deepEqual(cleanSettingSources(['user', 'project']), ['user']);
  assert.deepEqual(cleanSettingSources([]), []);
});

test('cleanRunPolicy turns off rules and hooks and marks the run clean, keeping the rest', () => {
  const base = runRequestFixture({ mcpToolAllowlist: ['cortex-core'] }).policy;
  const policy = cleanRunPolicy({ ...base, skills: true });
  assert.equal(policy.clean, true);
  assert.equal(policy.hooks, false);
  assert.equal(policy.loadRules, false);
  assert.equal(policy.skills, true);
  assert.deepEqual(policy.mcpToolAllowlist, ['cortex-core']);
  assert.deepEqual(policy.settingSources, ['user', 'local']);
});

test('a clean spec runs in the workspace, appends the workspace section after the role and flags clean', () => {
  const spec = buildEngineSpec(cleanRequest(), attemptFixture());
  assert.equal(spec.cwd, WORKSPACE);
  assert.equal(spec.flags.clean, true);
  assert.equal(spec.flags.disableHooks, true);
  assert.deepEqual(spec.flags.settingSources, ['user', 'local']);
  const append = spec.prompt.append ?? '';
  assert.ok(append.startsWith('ROLE BODY'), 'no rules precede the role body');
  assert.ok(append.includes(`the current directory, ${WORKSPACE}.`));
  assert.ok(append.indexOf('ROLE BODY') < append.indexOf('## Workspace'));
});

test('an ordinary spec carries no clean flag and no workspace section', () => {
  const spec = buildEngineSpec(runRequestFixture({ appendSystemPrompt: 'ROLE BODY', loadCortexRules: false }), attemptFixture());
  assert.equal('clean' in spec.flags, false);
  assert.equal(spec.prompt.append, 'ROLE BODY');
});

function settingsOf(args: string[]): Record<string, unknown> {
  return JSON.parse(args[args.indexOf('--settings') + 1]);
}

test('the Claude launch of a clean spec drops the project setting source and git context, in the workspace', () => {
  const launch = launchFromSpec(buildEngineSpec(cleanRequest(), attemptFixture()));
  assert.equal(launch.options.cwd, WORKSPACE);
  const { args } = claudeProcessLaunch(launch);
  const at = args.indexOf('--setting-sources');
  assert.ok(at >= 0);
  assert.equal(args[at + 1], 'user,local');
  assert.equal(settingsOf(args).includeGitInstructions, false, 'the enclosing repo stays out of the prompt');

  const plain = claudeProcessLaunch(launchFromSpec(buildEngineSpec(runRequestFixture({ channel: 'web:clean' }), attemptFixture())));
  assert.equal('includeGitInstructions' in settingsOf(plain.args), false);
});

test('the PI request of a clean spec loads no context files and names its workspace for children', () => {
  const spec = buildEngineSpec(cleanRequest(), attemptFixture({ backend: 'pi', provider: 'deepseek', model: 'flash', mode: 'deepseek' }));
  const inputs = { agentDir: '/srv/pi', sessionDir: '/srv/pi/sessions', sessionPath: null, cwd: WORKSPACE, streamDeltas: false };
  const request = buildSessionRequest(spec, inputs);
  assert.equal(request.noContextFiles, true);
  assert.equal(request.env[PI_CLEAN_WORKSPACE_ENV], WORKSPACE);

  const plain = buildSessionRequest(buildEngineSpec(runRequestFixture({ channel: 'web:clean' }), attemptFixture({ backend: 'pi', provider: 'deepseek', model: 'flash', mode: 'deepseek' })), {
    ...inputs, cwd: path.dirname(WORKSPACE),
  });
  assert.equal('noContextFiles' in plain, false);
  assert.equal(plain.env[PI_CLEAN_WORKSPACE_ENV], undefined);
  assert.notEqual(sessionIdentity(request), sessionIdentity(plain));
});
