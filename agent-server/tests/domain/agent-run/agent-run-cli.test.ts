// input:  agent-run CLI entry, temporary paths, shared help utilities
// output: explicit-flag, required-option, stdin, and help contracts
// pos:    One-shot agent-run command surface regression suite
// >>> If I am updated, update my header and folder CORTEX.md <<<

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'vitest';
import {
  getAgentRunHelp,
  parseAgentRunArgs,
  runAgentRunCli,
} from '../../../src/domain/agent-run/agent-run-cli.js';

let root = '';
let previousSupervisor: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-run-cli-'));
  previousSupervisor = process.env.CORTEX_SUPERVISOR_BINARY;
  process.env.CORTEX_SUPERVISOR_BINARY = process.execPath;
});

afterEach(() => {
  if (previousSupervisor === undefined) delete process.env.CORTEX_SUPERVISOR_BINARY;
  else process.env.CORTEX_SUPERVISOR_BINARY = previousSupervisor;
  fs.rmSync(root, { recursive: true, force: true });
});

function writeExecutable(name: string): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return file;
}

function validArgs(): string[] {
  const prompt = path.join(root, 'prompt.txt');
  const cwd = path.join(root, 'task');
  fs.writeFileSync(prompt, 'solve this\n');
  fs.mkdirSync(cwd, { recursive: true });
  return [
    '--prompt-file', prompt,
    '--agent-slot', 'parent',
    '--profile', 'fixture',
    '--cwd', cwd,
    '--output-format', 'jsonl',
    '--events-file', path.join(root, 'events.jsonl'),
  ];
}

describe('parseAgentRunArgs', () => {
  it('parses required explicit flags and stable defaults', () => {
    const parsed = parseAgentRunArgs(validArgs());
    assert.equal(parsed.agentSlot, 'parent');
    assert.equal(parsed.profile, 'fixture');
    assert.equal(parsed.outputFormat, 'jsonl');
    assert.equal(parsed.cwd, fs.realpathSync(path.join(root, 'task')));
    assert.equal(parsed.eventsFile, path.join(root, 'events.jsonl'));
    assert.equal(parsed.supervisorBinary, fs.realpathSync(process.execPath));
    assert.equal(parsed.trajectoryRoot, root);
    assert.equal(parsed.runConfigFile, undefined);
    assert.equal(parsed.graceMs, 1_000);
    assert.equal(parsed.deadlineMs, undefined);
  });

  it('accepts stdin and every supported agent slot as labels', () => {
    for (const slot of ['parent', 'benchmark-coder', 'benchmark-reviewer'] as const) {
      const args = validArgs();
      args[1] = '-';
      args[3] = slot;
      assert.equal(parseAgentRunArgs(args).agentSlot, slot);
    }
  });

  it('accepts approved optional configuration and lifecycle flags', () => {
    const runConfigFile = path.join(root, 'run-config.json');
    const supervisor = writeExecutable('optional-supervisor');
    const parsed = parseAgentRunArgs([
      ...validArgs(),
      '--run-config', runConfigFile,
      '--trajectory-root', root,
      '--supervisor-binary', supervisor,
      '--deadline-ms', '1234',
      '--grace-ms', '55',
      '--root-run-id', 'run.fixture-1',
    ]);
    assert.equal(parsed.runConfigFile, runConfigFile);
    assert.equal(parsed.trajectoryRoot, root);
    assert.equal(parsed.supervisorBinary, fs.realpathSync(supervisor));
    assert.equal(parsed.deadlineMs, 1234);
    assert.equal(parsed.graceMs, 55);
    assert.equal(parsed.rootRunId, 'run.fixture-1');
  });

  it('preserves the run-config stdin marker', () => {
    const parsed = parseAgentRunArgs([...validArgs(), '--run-config', '-']);
    assert.equal(parsed.runConfigFile, '-');
  });

  it('rejects assigning the single stdin stream to both file inputs', () => {
    const args = [...validArgs(), '--run-config', '-'];
    args[1] = '-';
    assert.throws(
      () => parseAgentRunArgs(args),
      (error: Error) => error.message.includes("Cannot use '-' for both --prompt-file and --run-config")
        && error.message.includes('Use --prompt-file <path> with --run-config -')
        && error.message.includes('--prompt-file - with --run-config <path>'),
    );
  });

  it('uses explicit supervisor over environment over the package default', () => {
    const environment = writeExecutable('environment-supervisor');
    const explicitPath = writeExecutable('explicit-supervisor');
    const fromEnvironment = parseAgentRunArgs(
      validArgs(), { CORTEX_SUPERVISOR_BINARY: environment },
    );
    assert.equal(fromEnvironment.supervisorBinary, fs.realpathSync(environment));
    const explicit = parseAgentRunArgs([
      ...validArgs(), '--supervisor-binary', explicitPath,
    ], { CORTEX_SUPERVISOR_BINARY: environment });
    assert.equal(explicit.supervisorBinary, fs.realpathSync(explicitPath));
  });

  it('reports missing required flags with a fix path', () => {
    assert.throws(() => parseAgentRunArgs([]), /Missing required --prompt-file/);
  });

  it('reports invalid values and valid alternatives', () => {
    const invalidSlot = validArgs();
    invalidSlot[3] = 'reviewer';
    assert.throws(
      () => parseAgentRunArgs(invalidSlot),
      /Valid values: parent, benchmark-coder, benchmark-reviewer/,
    );
    const invalidFormat = validArgs();
    invalidFormat[9] = 'json';
    assert.throws(() => parseAgentRunArgs(invalidFormat), /Valid values: jsonl/);
  });

  it('rejects unknown flags, unsafe ids, invalid durations and non-directory cwd', () => {
    assert.throws(() => parseAgentRunArgs([...validArgs(), '--wat']), /Unknown option: '--wat'/);
    assert.throws(
      () => parseAgentRunArgs([...validArgs(), '--root-run-id', '../escape']),
      /Invalid --root-run-id/,
    );
    assert.throws(
      () => parseAgentRunArgs([...validArgs(), '--deadline-ms', '-1']),
      /Invalid --deadline-ms/,
    );
    assert.throws(
      () => parseAgentRunArgs([...validArgs(), '--trajectory-root', path.join(root, 'other')]),
      /--events-file must be within --trajectory-root/,
    );
    const args = validArgs();
    args[7] = args[1];
    assert.throws(() => parseAgentRunArgs(args), /Invalid --cwd/);
  });

  it('does not expose an inapplicable dry-run flag', () => {
    assert.throws(() => parseAgentRunArgs([...validArgs(), '--dry-run']), /Unknown option: '--dry-run'/);
  });
});

it('keeps output-format required in both help and the real parser', async () => {
  const help = getAgentRunHelp();
  assert.match(help, /Usage: .* --output-format jsonl --events-file/);
  assert.doesNotMatch(help, /--output-format[^\n]+\(default: jsonl\)/);
  const args = validArgs();
  args.splice(args.indexOf('--output-format'), 2);
  let stderr = '';
  const exitCode = await runAgentRunCli(args, {
    stdout: { write: () => true },
    stderr: { write: value => { stderr += String(value); return true; } },
  });
  assert.equal(exitCode, 1);
  assert.match(stderr, /Missing required --output-format/);
});

it('renders copyable help with defaults and stdin support', () => {
  const help = getAgentRunHelp();
  assert.match(help, /Usage: cortex agent-run --prompt-file <path\|->/);
  assert.match(help, /--agent-slot <slot>/);
  assert.match(help, /--trajectory-root <dir>/);
  assert.match(help, /--run-config <path\|->/);
  assert.match(help, /stdin paths use process cwd/);
  assert.match(help, /CORTEX_SUPERVISOR_BINARY/);
  assert.doesNotMatch(help, /--dry-run/);
  assert.match(help, /cat prompt\.txt \| cortex agent-run --prompt-file -/);
});
