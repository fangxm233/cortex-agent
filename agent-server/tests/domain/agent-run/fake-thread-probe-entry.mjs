// input:  compiled thread runtime, pinned Cortex paths, fake agent loader
// output: one completed step, flushed stores, and phase markers
// pos:    Current-runner lifecycle target for the baseline probe
// >>> If I am updated, update my header and folder CORTEX.md <<<

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DIST = path.join(AGENT_ROOT, 'dist');
const cortexHome = process.env.CORTEX_HOME;
const logsDir = path.join(path.dirname(cortexHome), 'logs');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function seedConfig() {
  writeJson(path.join(cortexHome, 'config/profiles.json'), {
    defaultProfile: 'baseline',
    profiles: {
      baseline: {
        model: 'fixture-model',
        backend: 'claude',
        claudeBackend: 'print',
        provider: 'anthropic',
        fallback: [],
      },
    },
  });
  writeJson(path.join(cortexHome, 'config/thread-templates/agents/probe-agent.json'), {
    name: 'probe-agent',
    description: 'No-model access baseline agent',
    profile: 'baseline',
    persistSession: false,
    directive: '',
    promptTemplate: '{{input}}',
    tools: 'Read',
    pluginDirs: [],
  });
  writeJson(path.join(cortexHome, 'config/thread-templates/templates/probe-template.json'), {
    name: 'probe-template',
    description: 'One-step access baseline template',
    agents: ['probe-agent'],
    transitions: [],
    entryAgent: 'probe-agent',
    maxTotalSteps: 1,
  });
  fs.mkdirSync(path.join(cortexHome, 'config/thread-templates/shells'), { recursive: true });
}

function markPhase(name) {
  fs.writeFileSync(path.join(logsDir, name), new Date().toISOString());
}

seedConfig();

const [
  { executionRepo },
  { profileRepo },
  { threadStore },
  { sessionStore },
  { conversationHistory },
  { loadConfig },
  { createThread },
  { runThread },
  { MockAdapter },
] = await Promise.all([
  import(path.join(DIST, 'store/execution-repo.js')),
  import(path.join(DIST, 'store/profile-repo.js')),
  import(path.join(DIST, 'store/thread-repo.js')),
  import(path.join(DIST, 'store/session-registry-repo.js')),
  import(path.join(DIST, 'store/conversation-history-repo.js')),
  import(path.join(DIST, 'domain/threads/template-loader.js')),
  import(path.join(DIST, 'domain/threads/state-machine.js')),
  import(path.join(DIST, 'domain/threads/runner.js')),
  import(path.join(DIST, 'platform/testing.js')),
]);
markPhase('phase-1-module-import.done');

executionRepo.load();
loadConfig();
threadStore.load();
markPhase('phase-2-store-template-init.done');

const channel = 'probe-baseline';
const thread = createThread(channel, {
  templateName: 'probe-template',
  userMessage: 'execute one fake step',
  userMessageTs: '1.000',
  projectId: 'probe-project',
});
const result = await runThread(thread.id, {
  adapter: new MockAdapter(),
  channel,
  destination: { type: 'interactive-reply', conduit: channel, sessionId: 'probe' },
  threadAnchorId: null,
  statusMsg: null,
  startTime: Date.now(),
  onProgress: null,
});
markPhase('phase-3-one-step.done');

await Promise.all([
  threadStore.flush(),
  executionRepo.flush(),
  sessionStore.flush(),
  conversationHistory.flush(),
  profileRepo.flush(),
]);
markPhase('phase-4-flush.done');

const marker = path.join(cortexHome, 'data/fake-run-agent.jsonl');
const invocations = fs.readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).length;
writeJson(path.join(logsDir, 'baseline-result.json'), {
  threadId: thread.id,
  status: result.thread.status,
  steps: result.thread.steps.length,
  costUsd: result.totalCostUsd,
  invocations,
});
