// input:  agent-run process fixture, stdin config, fake accounting
// output: stdin, accounting, identity, and trajectory failure proofs
// pos:    Process-level agent-run protocol regression suite
// >>> If I am updated, update my header and folder CORTEX.md <<<

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'vitest';
import {
  collect,
  createFixture,
  fakeClaudeResult,
  fixtureRoot,
  installFailingWriteHook,
  parseNdjson,
  processOutput,
  sha256,
  spawnRun,
  terminalPath,
  terminalRecord,
  waitForExit,
  waitForText,
} from './agent-run-e2e-fixture.js';

it('reads a stdin run config with relative paths based at the invoking cwd', async () => {
  const fixture = createFixture('stdin-run-config');
  const configIndex = fixture.args.indexOf('--run-config');
  const configPath = fixture.args[configIndex + 1];
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const mcpPath = path.join(path.dirname(configPath), 'mcp-config-empty.json');
  config.role.mcp_config_paths = [path.relative(process.cwd(), mcpPath)];
  fixture.args[configIndex + 1] = '-';
  const child = spawnRun(fixture, {}, JSON.stringify(config));
  await waitForText(fixture.eventsFile, 'turn_complete', child);
  fs.writeFileSync(fixture.releaseMarker, 'release');
  const output = await processOutput(child);
  assert.equal(child.exitCode, 0, output.stderr);
  assert.equal(terminalRecord(fixture).terminal_reason, 'ok');
});

it('rejects two stdin file inputs before launching Claude', async () => {
  const fixture = createFixture('stdin-conflict');
  fixture.args[1] = '-';
  fixture.args[fixture.args.indexOf('--run-config') + 1] = '-';
  const child = spawnRun(fixture, {}, 'single stdin stream');
  const output = await processOutput(child);
  assert.equal(child.exitCode, 1);
  assert.match(output.stderr, /Cannot use '-' for both --prompt-file and --run-config/);
  assert.match(output.stderr, /--prompt-file <path> with --run-config -/);
  assert.match(output.stderr, /--prompt-file - with --run-config <path>/);
  assert.equal(fs.existsSync(fixture.claudeMarker), false);
});

it('preserves raw stdin bytes while hashing the model-visible string', async () => {
  const fixture = createFixture();
  fixture.args[1] = '-';
  const promptCapture = path.join(fixtureRoot(), 'prompt-capture.json');
  const prompt = Buffer.from([0x66, 0x80, 0x0a]);
  const modelVisible = prompt.toString('utf8');
  const child = spawnRun(fixture, { PROMPT_CAPTURE: promptCapture }, prompt);
  await waitForText(fixture.eventsFile, 'turn_complete', child);
  fs.writeFileSync(fixture.releaseMarker, 'release');
  const output = await processOutput(child);
  assert.equal(child.exitCode, 0, output.stderr);
  const request = JSON.parse(fs.readFileSync(promptCapture, 'utf8'));
  assert.equal(request.message.content, modelVisible);
  const header = parseNdjson(fs.readFileSync(fixture.eventsFile, 'utf8'))[0];
  assert.equal(header.canonical_instruction_sha256, sha256(prompt));
  assert.equal(header.model_visible_prompt_sha256, sha256(modelVisible));
});

it('keeps unreported cost and usage null without fabricating cost records', async () => {
  const fixture = createFixture('unknown-accounting');
  const first = fakeClaudeResult('e2e-run', 'unknown');
  const continuation = fakeClaudeResult('e2e-run', 'unknown', {
    origin: { kind: 'task-notification' },
  });
  const child = spawnRun(fixture, {
    FAKE_CLAUDE_FIRST_RESULT: first,
    FAKE_CLAUDE_CONTINUATION_RESULT: continuation,
  });
  await waitForText(fixture.eventsFile, 'turn_complete', child);
  fs.writeFileSync(fixture.releaseMarker, 'release');
  const output = await processOutput(child);
  assert.equal(child.exitCode, 0, output.stderr);
  const records = parseNdjson(fs.readFileSync(fixture.eventsFile, 'utf8'));
  assert.deepEqual(records.filter(record => record.event?.type === 'cost_record'), []);
  const terminal = terminalRecord(fixture);
  assert.equal(terminal.cost_usd, null);
  assert.deepEqual(terminal.tokens, { input: null, output: null });
});

it('exits when only the background continuation reports cost', async () => {
  const fixture = createFixture('continuation-accounting');
  fs.writeFileSync(fixture.releaseMarker, 'release');
  const first = fakeClaudeResult('e2e-run', 'unknown');
  const continuation = fakeClaudeResult('e2e-run', 'reported continuation', {
    origin: { kind: 'task-notification' }, total_cost_usd: 0.125,
  });
  const child = spawnRun(fixture, {
    FAKE_CLAUDE_FIRST_RESULT: first,
    FAKE_CLAUDE_CONTINUATION_RESULT: continuation,
    FAKE_CLAUDE_EARLY_CONTINUATION: '1',
  });
  const output = await processOutput(child);
  assert.equal(child.exitCode, 0, output.stderr);
  assert.equal(terminalRecord(fixture).cost_usd, 0.125);
  assert.deepEqual(terminalRecord(fixture).tokens, { input: null, output: null });
});

function assertEarlyAccountingOrder(events: any[]): void {
  assert.deepEqual(events.filter(event => event.type === 'cost_record'), [{
    type: 'cost_record', provider: 'anthropic', model: 'claude-foreground',
    tokens_in: 111, tokens_out: 22, cost_usd: 0.2,
  }]);
  const selected = events.filter(event =>
    event.type === 'cost_record' || event.type === 'turn_complete'
      || (event.type === 'assistant_text' && event.text === 'background done'));
  assert.deepEqual(selected.map(event =>
    event.type === 'assistant_text' ? `assistant:${event.text}` : event.type), [
    'cost_record', 'turn_complete', 'assistant:background done', 'turn_complete',
  ]);
}

it('keeps early continuation events after immutable foreground accounting', async () => {
  const fixture = createFixture('early-distinct-accounting');
  fs.writeFileSync(fixture.releaseMarker, 'release');
  const first = fakeClaudeResult('e2e-run', 'foreground', {
    total_cost_usd: 0.2,
    usage: { input_tokens: 111, output_tokens: 22 },
    modelUsage: { 'claude-foreground': {} },
  });
  const continuation = fakeClaudeResult('e2e-run', 'continuation', {
    origin: { kind: 'task-notification' }, total_cost_usd: 0.3,
    usage: { input_tokens: 9, output_tokens: 4 },
    modelUsage: { 'claude-continuation': {} },
  });
  const child = spawnRun(fixture, {
    FAKE_CLAUDE_FIRST_RESULT: first,
    FAKE_CLAUDE_CONTINUATION_RESULT: continuation,
    FAKE_CLAUDE_EARLY_CONTINUATION: '1',
  });
  const output = await processOutput(child);
  assert.equal(child.exitCode, 0, output.stderr);
  const events = parseNdjson(fs.readFileSync(fixture.eventsFile, 'utf8'))
    .map(record => record.event).filter(Boolean);
  assertEarlyAccountingOrder(events);
  assert.equal(terminalRecord(fixture).cost_usd, 0.3);
});

it.each([
  { kind: 'non-zero', fixtureName: 'reported-accounting', cost: 0.375, input: 321, tokenOutput: 54 },
  { kind: 'zero', fixtureName: 'reported-zero-accounting', cost: 0, input: 0, tokenOutput: 0 },
])('preserves explicitly reported $kind accounting exactly', async ({ fixtureName, cost, input, tokenOutput }) => {
  const fixture = createFixture(fixtureName);
  const reported = fakeClaudeResult('e2e-run', 'reported', {
    total_cost_usd: cost,
    usage: { input_tokens: input, output_tokens: tokenOutput },
    modelUsage: { 'claude-reported-accounting': {} },
  });
  const continuation = fakeClaudeResult('e2e-run', 'reported continuation', {
    origin: { kind: 'task-notification' }, total_cost_usd: cost,
  });
  const child = spawnRun(fixture, {
    FAKE_CLAUDE_FIRST_RESULT: reported,
    FAKE_CLAUDE_CONTINUATION_RESULT: continuation,
  });
  await waitForText(fixture.eventsFile, 'turn_complete', child);
  fs.writeFileSync(fixture.releaseMarker, 'release');
  const output = await processOutput(child);
  assert.equal(child.exitCode, 0, output.stderr);
  const records = parseNdjson(fs.readFileSync(fixture.eventsFile, 'utf8'));
  const costEvents = records.filter(record => record.event?.type === 'cost_record')
    .map(record => record.event);
  assert.deepEqual(costEvents, [{
    type: 'cost_record', provider: 'anthropic', model: 'claude-reported-accounting',
    tokens_in: input, tokens_out: tokenOutput, cost_usd: cost,
  }]);
  const terminal = terminalRecord(fixture);
  assert.equal(terminal.cost_usd, cost);
  assert.deepEqual(terminal.tokens, { input, output: tokenOutput });
});

it('records reported cost when usage is absent', async () => {
  const fixture = createFixture('cost-only-accounting');
  const reported = fakeClaudeResult('e2e-run', 'reported cost', {
    total_cost_usd: 0.625,
  });
  const continuation = fakeClaudeResult('e2e-run', 'reported continuation', {
    origin: { kind: 'task-notification' }, total_cost_usd: 0.625,
  });
  const child = spawnRun(fixture, {
    FAKE_CLAUDE_FIRST_RESULT: reported,
    FAKE_CLAUDE_CONTINUATION_RESULT: continuation,
  });
  await waitForText(fixture.eventsFile, 'turn_complete', child);
  fs.writeFileSync(fixture.releaseMarker, 'release');
  const output = await processOutput(child);
  assert.equal(child.exitCode, 0, output.stderr);
  const costEvents = parseNdjson(fs.readFileSync(fixture.eventsFile, 'utf8'))
    .filter(record => record.event?.type === 'cost_record')
    .map(record => record.event);
  assert.deepEqual(costEvents, [{
    type: 'cost_record', provider: 'anthropic', model: 'claude-requested-fixture',
    tokens_in: null, tokens_out: null, cost_usd: 0.625,
  }]);
  const terminal = terminalRecord(fixture);
  assert.equal(terminal.cost_usd, 0.625);
  assert.deepEqual(terminal.tokens, { input: null, output: null });
});

it('includes the probed Claude version in frozen model identity', async () => {
  const identities: string[] = [];
  for (const [name, version] of [['version-a', 'fixture-claude 1'], ['version-b', 'fixture-claude 2']]) {
    const fixture = createFixture(name);
    const child = spawnRun(fixture, { FAKE_CLAUDE_VERSION: version });
    await waitForText(fixture.eventsFile, 'turn_complete', child);
    fs.writeFileSync(fixture.releaseMarker, 'release');
    const output = await processOutput(child);
    assert.equal(parseNdjson(output.stdout).at(-1).ok, true);
    identities.push(parseNdjson(fs.readFileSync(fixture.eventsFile, 'utf8'))[0]
      .model_execution_identity_hash);
  }
  assert.notEqual(identities[0], identities[1]);
});

it('does not turn a closed diagnostics pipe into a trajectory failure', async () => {
  const fixture = createFixture();
  const child = spawnRun(fixture);
  child.stdout!.destroy();
  const stderr = collect(child.stderr!);
  await waitForText(fixture.eventsFile, 'turn_complete', child);
  fs.writeFileSync(fixture.releaseMarker, 'release');
  await waitForExit(child);
  assert.equal(child.exitCode, 0, await stderr);
  assert.equal(terminalRecord(fixture).terminal_reason, 'ok');
});

it('rejects an existing started marker before creating a journal or spawning Claude', async () => {
  const fixture = createFixture();
  const marker = path.join(fixture.trajectoryRoot, 'run-e2e-run.started.json');
  const original = '{"existing":true}\n';
  fs.writeFileSync(marker, original);
  const output = await processOutput(spawnRun(fixture));
  assert.equal(parseNdjson(output.stdout).at(-1).terminal_reason, 'trajectory_write_failed');
  assert.equal(fs.existsSync(fixture.eventsFile), false);
  assert.equal(fs.existsSync(fixture.claudeMarker), false);
  assert.equal(fs.readFileSync(marker, 'utf8'), original);
});

it('turns a required event write failure into trajectory_write_failed', async () => {
  const fixture = createFixture();
  fs.writeFileSync(fixture.releaseMarker, 'release');
  const hook = path.join(fixtureRoot(), 'fail-write.mjs');
  installFailingWriteHook(hook);
  const child = spawnRun(fixture, { FAIL_WRITE_PATH: fixture.eventsFile }, undefined, [hook]);
  const output = await processOutput(child);
  assert.equal(child.exitCode, 74, output.stderr);
  assert.equal(parseNdjson(output.stdout).at(-1).terminal_reason, 'trajectory_write_failed');
  if (fs.existsSync(terminalPath(fixture))) {
    assert.equal(terminalRecord(fixture).state, 'failed');
    assert.equal(terminalRecord(fixture).terminal_reason, 'trajectory_write_failed');
  }
  assert.equal(
    fs.existsSync(terminalPath(fixture)) && terminalRecord(fixture).state === 'completed', false,
  );
});

it('fails a trajectory open without launching Claude or publishing completion', async () => {
  const fixture = createFixture();
  fs.chmodSync(fixture.trajectoryRoot, 0o500);
  const child = spawnRun(fixture);
  const output = await processOutput(child);
  fs.chmodSync(fixture.trajectoryRoot, 0o700);
  assert.equal(child.exitCode, 74, output.stderr);
  assert.equal(parseNdjson(output.stdout).at(-1).terminal_reason, 'trajectory_write_failed');
  assert.equal(fs.existsSync(fixture.claudeMarker), false);
  assert.equal(fs.existsSync(terminalPath(fixture)), false);
});
