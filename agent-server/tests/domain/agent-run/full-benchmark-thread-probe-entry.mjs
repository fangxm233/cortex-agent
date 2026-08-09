// input:  compiled orchestrator, startup MCP bootstrap, supervisor
// output: four-step identity receipt and committed terminal manifest
// pos:    Full benchmark-thread target for the C8 syscall probe
// >>> If I am updated, update my header and folder CORTEX.md <<<

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const supervisor = process.argv[2];
if (!supervisor) throw new Error('supervisor path is required');
process.env.CORTEX_SUPERVISOR_BINARY = supervisor;

const agentRoot = fileURLToPath(new URL('../../../', import.meta.url));
const cortexHome = process.env.CORTEX_HOME;
if (!cortexHome) throw new Error('CORTEX_HOME is required');
const logsDir = path.join(path.dirname(cortexHome), 'logs');
const templateRoot = path.join(cortexHome, 'config/thread-templates');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function copyDefault(kind, name) {
  const source = path.join(
    agentRoot, 'defaults/config/thread-templates', kind, `${name}.json`,
  );
  const destination = path.join(templateRoot, kind, `${name}.json`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, fs.readFileSync(source));
}

writeJson(path.join(cortexHome, 'config/profiles.json'), {
  defaultProfile: 'fixture',
  profiles: {
    fixture: {
      model: 'fixture-model', backend: 'claude', claudeBackend: 'print',
      provider: 'anthropic', fallback: [],
    },
  },
});
copyDefault('agents', 'benchmark-coder');
copyDefault('agents', 'benchmark-reviewer');
copyDefault('templates', 'benchmark-coder-review');
fs.mkdirSync(path.join(templateRoot, 'shells'), { recursive: true });
// The agent documents name their prompts as `file:` refs, which resolve against DATA_DIR/prompts.
// Copied read+write like the documents above rather than with cpSync, whose sendfile(2) is not one
// of the syscalls the C8 boundary classifies and would be counted as a violation of this probe.
for (const kind of ['directives', 'systemPrompts']) {
  for (const name of ['benchmark-coder', 'benchmark-reviewer']) {
    const source = path.join(agentRoot, 'defaults/prompts', kind, `${name}.md`);
    const destination = path.join(cortexHome, 'prompts', kind, `${name}.md`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, fs.readFileSync(source));
  }
}

const { ensureMcpConfig } = await import(
  path.join(agentRoot, 'dist/entry/startup-helpers.js')
);
ensureMcpConfig();
const { runBenchmarkThread } = await import(
  path.join(agentRoot, 'dist/domain/agent-run/benchmark-local-thread-orchestrator.js')
);
const { openJournal } = await import(
  path.join(agentRoot, 'dist/domain/agent-run/journal.js')
);
const { writeStartedMarker } = await import(
  path.join(agentRoot, 'dist/domain/agent-run/manifest.js')
);
const trajectoryRoot = path.join(cortexHome, 'tmp/trajectory');
fs.mkdirSync(trajectoryRoot, { recursive: true });
const parentJournal = openJournal({
  path: path.join(trajectoryRoot, 'parent.journal.ndjson'),
  header: {
    rootRunId: 'full-benchmark-thread-probe', threadId: null, agentSlot: 'parent',
    resolvedCwd: process.cwd(), canonicalInstructionSha256: 'a'.repeat(64),
    modelVisiblePromptSha256: 'b'.repeat(64), systemPromptSha256: 'c'.repeat(64),
    toolManifestSha256: 'd'.repeat(64), pluginManifestSha256: 'e'.repeat(64),
    modelExecutionIdentityHash: '1'.repeat(64), roleToolSurfaceHash: '2'.repeat(64),
    bundleManifestHash: '3'.repeat(64),
  },
});
parentJournal.writeEvent({
  threadId: null, step: null, agentSlot: 'parent', backend: 'claude', provider: 'anthropic',
  requestedModel: 'fixture-model', reportedModel: null,
  event: { type: 'tool_use', toolUseId: 'thread-call', name: 'thread_run', input: {} },
});
writeStartedMarker({
  trajectoryRoot, rootRunId: 'full-benchmark-thread-probe', threadId: null,
  journalPath: parentJournal.path,
});
function fakeRunAgent(prompt, options) {
  const marker = path.join(cortexHome, 'data/fake-run-agent.jsonl');
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.appendFileSync(marker, `${JSON.stringify({ prompt, cwd: options.cwd })}\n`);
  const events = [
    { type: 'assistant_text', text: 'fake step complete', model: 'fixture-reported' },
    { type: 'turn_complete', numTurns: 1, totalCostUsd: 0 },
  ];
  for (const event of events) {
    for (const sink of options.requiredSinks ?? []) sink.onEvent(event);
  }
  options.onAssistantMessage?.('fake step complete');
  return {
    sessionId: 'fake-backend-session',
    agentProcess: null,
    kill: () => true,
    promise: Promise.resolve({
      finalOutput: 'fake step complete', sessionId: 'fake-backend-session',
      total_cost_usd: 0, num_turns: 1, rateLimited: false,
    }),
  };
}

const controller = new AbortController();
const result = await runBenchmarkThread({
  workspaceCwd: process.cwd(),
  template: 'benchmark-coder-review',
  instruction: 'exercise the complete fake benchmark thread',
  profileName: 'fixture',
  rootRunId: 'full-benchmark-thread-probe',
  trajectoryRoot,
  limits: { maxSteps: 4, maxCostUsd: 0, deadlineEpochMs: Date.now() + 45_000 },
  signal: controller.signal,
}, { runAgent: fakeRunAgent });
await parentJournal.close();
const invocationFile = path.join(cortexHome, 'data/fake-run-agent.jsonl');
const invocations = fs.readFileSync(invocationFile, 'utf8').trim().split('\n').filter(Boolean);
const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
const journalRecords = fs.readFileSync(result.journalPath, 'utf8').trim().split('\n').map(JSON.parse);
if (result.state !== 'completed' || result.steps !== 4 || invocations.length !== 4) {
  throw new Error(`incomplete benchmark lifecycle: ${JSON.stringify(result)}`);
}
if (manifest.state !== 'completed') {
  throw new Error(`invalid terminal manifest state: ${manifest.state}`);
}
if (journalRecords.length !== 9) {
  throw new Error(`invalid child journal record count: ${journalRecords.length}`);
}
writeJson(path.join(logsDir, 'full-benchmark-thread-receipt.json'), {
  result,
  invocations: invocations.length,
  eventRecords: journalRecords.length - 1,
  manifestState: manifest.state,
});
