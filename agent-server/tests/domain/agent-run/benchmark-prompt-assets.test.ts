// input:  the three shipped benchmark agent documents and the prompts tree they now reference
// output: the extracted prompt assets, the removed inline strings, and the fail-closed resolution
// pos:    Prompt-asset extraction proof for the phase-A role maps
// >>> If I am updated, update my header and folder CORTEX.md <<<

// SEAM NOTE. The fail-closed half does not assert against a stub of the loader: the agent document
// is written into the live config directory, the real template loader resolves its `file:` ref
// against the real prompts directory, and the real benchmark orchestrator is the caller that
// refuses. Both sides of the loader/orchestrator seam execute.

import '../../_test-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({ runAgent: vi.fn() }));

vi.mock('../../../src/domain/agents/index.js', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  runAgent: harness.runAgent,
  getClaudeMode: () => 'api',
  closeSessionsByPrefix: () => {},
}));

import { CONFIG_DIR, DEFAULTS_DIR, PROMPTS_DIR } from '../../../src/core/paths.js';
import { runBenchmarkThread } from '../../../src/domain/agent-run/benchmark-local-thread-orchestrator.js';
import { loadConfig, getAgent } from '../../../src/domain/threads/template-loader.js';
import { profileRepo } from '../../../src/store/profile-repo.js';
import { seedShippedPrompts } from './benchmark-shipped-prompts.js';

const SHIPPED_TEMPLATES = path.join(DEFAULTS_DIR, 'config', 'thread-templates');
const SHIPPED_PROMPTS = path.join(DEFAULTS_DIR, 'prompts');
const LIVE_TEMPLATES = path.join(CONFIG_DIR, 'thread-templates');
const BENCHMARK_AGENTS = ['benchmark-coder', 'benchmark-reviewer', 'benchmark-fixer'] as const;

/** The exact strings design (14.2.2) extracts. Pinned here as literals so the test is evidence that
 *  the bytes SURVIVED the move: comparing the file against the document would pass for any pair of
 *  equal-but-wrong values, which is the drift RB-EXTRACT exists to prevent. */
const REMOVED_DIRECTIVE: Record<string, string> = {
  'benchmark-coder':
    'You are the benchmark coder. Work directly in the current task workspace, implement only the '
    + 'requested change, and verify the affected behavior with targeted checks. Do not assume the '
    + 'workspace is a git repository.',
  'benchmark-reviewer':
    'You are the benchmark reviewer. Independently inspect the current task workspace and verify '
    + 'the implementation without modifying project files. Report only evidence-backed blockers.',
  'benchmark-fixer':
    'You are the benchmark fixing reviewer. Independently inspect the current task workspace, '
    + 'verify the implementation against the task, and directly fix every blocker you can confirm '
    + 'with evidence. Work in place in the current workspace. Do not assume git, commits, a '
    + 'repository-wide test command, or any task-tracking system exists, and do not attempt to use '
    + 'one.',
};

const REMOVED_SYSTEM_PROMPT: Record<string, string> = {
  'benchmark-coder':
    'You are a code implementer operating in an isolated benchmark task workspace. Make the '
    + 'smallest correct change for the task and avoid unrelated refactors.',
  'benchmark-reviewer':
    'You are a read-only implementation auditor in an isolated benchmark task workspace. Inspect '
    + 'the implementation and run focused checks; write no files and report review findings as '
    + 'your final message.',
  'benchmark-fixer':
    'You are an implementation auditor operating in an isolated benchmark task workspace. You are '
    + 'the last stage of this pipeline: audit the implementation, and fix the blockers you confirm '
    + 'rather than reporting them. Keep every fix minimal and scoped to the blocker that motivated '
    + 'it. The workspace may not be a git repository and may have no repository-wide test command; '
    + 'verify only the behavior you changed.',
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-prompt-assets-'));
let previousSupervisorBinary: string | undefined;

function shippedDocument(name: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(SHIPPED_TEMPLATES, 'agents', `${name}.json`), 'utf8'),
  );
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function seedProfiles(): void {
  writeJson(path.join(CONFIG_DIR, 'profiles.json'), {
    defaultProfile: 'benchmark-fixture',
    profiles: {
      'benchmark-fixture': {
        model: 'fixture-model', backend: 'claude', claudeBackend: 'print',
        provider: 'anthropic', fallback: [],
      },
    },
  });
  profileRepo.invalidate();
}

/** Copy the shipped documents and the shipped prompts tree into the live home, so the loader under
 *  test reads exactly what an installed Cortex would. */
function seedShipped(): void {
  for (const name of BENCHMARK_AGENTS) {
    fs.mkdirSync(path.join(LIVE_TEMPLATES, 'agents'), { recursive: true });
    fs.copyFileSync(
      path.join(SHIPPED_TEMPLATES, 'agents', `${name}.json`),
      path.join(LIVE_TEMPLATES, 'agents', `${name}.json`),
    );
  }
  fs.copyFileSync(
    path.join(SHIPPED_TEMPLATES, 'templates', 'benchmark-coder-review.json'),
    path.join(LIVE_TEMPLATES, 'templates', 'benchmark-coder-review.json'),
  );
  seedShippedPrompts();
  loadConfig();
}

beforeAll(() => {
  fs.mkdirSync(path.join(LIVE_TEMPLATES, 'templates'), { recursive: true });
  seedProfiles();
  seedShipped();
});

beforeEach(() => {
  harness.runAgent.mockReset();
  // Real and executable, so the supervisor probe that runs before template resolution passes and
  // the refusal under test is the one this suite is about.
  previousSupervisorBinary = process.env.CORTEX_SUPERVISOR_BINARY;
  process.env.CORTEX_SUPERVISOR_BINARY = process.execPath;
});

afterEach(() => {
  if (previousSupervisorBinary === undefined) delete process.env.CORTEX_SUPERVISOR_BINARY;
  else process.env.CORTEX_SUPERVISOR_BINARY = previousSupervisorBinary;
  seedShipped();
});

afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

it('(14.2.2): the six extracted prompt files exist at their exact paths', () => {
  for (const name of BENCHMARK_AGENTS) {
    for (const subdir of ['systemPrompts', 'directives']) {
      const file = path.join(SHIPPED_PROMPTS, subdir, `${name}.md`);
      assert.equal(fs.existsSync(file), true, `missing prompt asset: ${file}`);
    }
  }
});

it('(14.2.2): each file carries the exact bytes of the string it replaced', () => {
  for (const name of BENCHMARK_AGENTS) {
    assert.equal(
      fs.readFileSync(path.join(SHIPPED_PROMPTS, 'directives', `${name}.md`), 'utf8'),
      REMOVED_DIRECTIVE[name],
      `${name} directive bytes`,
    );
    assert.equal(
      fs.readFileSync(path.join(SHIPPED_PROMPTS, 'systemPrompts', `${name}.md`), 'utf8'),
      REMOVED_SYSTEM_PROMPT[name],
      `${name} systemPrompt bytes`,
    );
  }
});

it('RB-EXTRACT: no benchmark agent document still carries an inline directive or systemPrompt', () => {
  for (const name of BENCHMARK_AGENTS) {
    const document = shippedDocument(name);
    // The inline string is REMOVED, not duplicated: two copies drift, and a drift makes phase B
    // hash bytes that never governed the run while both sides stay individually valid.
    assert.equal(document.directive, `file:${name}.md`, `${name} directive`);
    assert.equal(document.systemPrompt, `file:${name}.md`, `${name} systemPrompt`);
  }
});

it('RB-EXTRACT: the real loader resolves each reference back to the removed string', () => {
  for (const name of BENCHMARK_AGENTS) {
    const agent = getAgent(name);
    assert.ok(agent, `agent not loaded: ${name}`);
    assert.equal(agent.directive, REMOVED_DIRECTIVE[name], `${name} resolved directive`);
    assert.equal(agent.systemPrompt, REMOVED_SYSTEM_PROMPT[name], `${name} resolved systemPrompt`);
  }
});

it('RB-EXTRACT-PRE: a missing prompt file fails a benchmark run closed, never as a literal ref', () => {
  // resolveFileRef is fail-soft by design and is NOT changed here: it returns the raw `file:` value
  // when the read throws, which would make an entire systemPrompt the string `file:benchmark-coder.md`
  // and let the run proceed. The Gate-3-local assertion is what refuses.
  fs.rmSync(path.join(PROMPTS_DIR, 'systemPrompts', 'benchmark-coder.md'));
  loadConfig();
  assert.equal(getAgent('benchmark-coder')!.systemPrompt, 'file:benchmark-coder.md');

  const trajectoryRoot = path.join(root, 'fail-closed');
  const workspaceCwd = path.join(root, 'workspace');
  fs.mkdirSync(trajectoryRoot, { recursive: true });
  fs.mkdirSync(workspaceCwd, { recursive: true });

  return assert.rejects(
    runBenchmarkThread({
      workspaceCwd, template: 'benchmark-coder-review', instruction: 'fix the fixture',
      profileName: 'benchmark-fixture', rootRunId: 'run-fail-closed', trajectoryRoot,
      limits: { maxSteps: 1, maxCostUsd: 1, deadlineEpochMs: Date.now() + 30_000 },
      signal: new AbortController().signal,
    } as any),
    (error: Error) => {
      assert.match(error.message, /benchmark-coder/);
      assert.match(error.message, /systemPrompt/);
      assert.equal(harness.runAgent.mock.calls.length, 0);
      return true;
    },
  );
});
