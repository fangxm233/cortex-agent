// input:  StepRow, Chrome layout probe, long clickable subtask fixture
// output: right-thread activity containment regression
// pos:    Verifies expanded thread rows stay inside fixed-width cards
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ThreadDetail, ThreadStepDetail } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';
import { StepRow } from './RightThreadCard';

const chrome = [
  process.env.CHROME_BIN,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((candidate): candidate is string => !!candidate && existsSync(candidate)) ?? null;

const step: ThreadStepDetail = {
  stepIndex: 0,
  agentSlotId: 'manager',
  stage: 'step 1',
  status: 'running',
  executionId: null,
  sessionId: null,
  sessionName: null,
  costUsd: null,
  numTurns: null,
  durationS: null,
  startedAt: null,
  endedAt: null,
  outputSummary: null,
};

const detail: ThreadDetail = {
  id: 'thr_layout',
  templateName: 'manager',
  currentStep: { index: 0, name: 'step 1' },
  status: 'running',
  projectId: 'atlas',
  createdAt: '2026-07-29T00:00:00.000Z',
  updatedAt: '2026-07-29T00:00:00.000Z',
  totalSteps: 1,
  artifactPath: null,
  endedAt: null,
  error: null,
  abortReason: null,
  activeAgent: 'manager',
  activeStage: 'step 1',
  totalCostUsd: 0,
  steps: [step],
  agentFlow: null,
  dispatches: [],
  subtasks: [{
    id: 'a293',
    text: 'Build the hook registry foundation: HookEntry schema and standalone loader with managed defaults',
    status: 'open',
    actionable: false,
    claimedBy: 'task-dispatcher',
    blockedBy: null,
  }],
  children: [],
  artifacts: { artifactPath: null, workspacePath: null, taskId: null, taskProject: null },
};

function renderFixture(): string {
  return renderToStaticMarkup(
    <LangProvider>
      <div id="card" style={{ boxSizing: 'border-box', width: 360, padding: '10px 14px 4px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '16px 1fr', columnGap: 9 }}>
          <StepRow step={step} isLast detail={detail} onOpenRun={() => {}} onOpenTask={() => {}} />
        </div>
      </div>
    </LangProvider>,
  );
}

function probeLayout(markup: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cortex-thread-layout-'));
  const file = path.join(dir, 'fixture.html');
  const script = `<script>const card=document.querySelector('#card');const row=document.querySelector('[data-subtask-id]');document.body.dataset.overflow=String(row.getBoundingClientRect().right>card.getBoundingClientRect().right+0.5)</script>`;
  writeFileSync(file, `<!doctype html><style>*{box-sizing:border-box}body{margin:0}</style>${markup}${script}`);
  try {
    return execFileSync(chrome!, ['--headless=new', '--no-sandbox', '--disable-gpu', '--dump-dom', pathToFileURL(file).href], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('RightThreadCard activity layout', () => {
  it.skipIf(chrome === null)('keeps long subtask rows inside the thread card', () => {
    const dumpedHtml = probeLayout(renderFixture());
    expect(dumpedHtml).toContain('data-overflow="false"');
  });
});
