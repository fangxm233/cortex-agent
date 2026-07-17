// input:  Node test runner + recommendation-extractor + fs
// output: extraction + TASKS.yaml dedup regression tests
// pos:    Verify recommendation extraction and dedup
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import './_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROJECTS_DIR } from '../src/core/paths.js';
import { scanProjectRecommendations } from '../src/domain/tasks/recommendation/extractor.js';

test('scanProjectRecommendations extracts actionable recommendations and marks duplicates from TASKS.yaml', () => {
  const project = '_test_rec_demo';
  const projectDir = path.join(PROJECTS_DIR, project);
  fs.mkdirSync(projectDir, { recursive: true });

  // Track files to clean
  const files: string[] = [];

  try {
    const writeFile = (name: string, content: string) => {
      const p = path.join(projectDir, name);
      fs.writeFileSync(p, content);
      files.push(p);
    };

    writeFile('EXPERIMENTS.md', `# Demo Experiments

### EXP-001: Prompt quality

**Date**: 2099-03-12

#### Reflection
- **行为调整**: tighten prompt scope before broad scans

## Next steps
- Implement prompt guard for dispatch workers
`);

    writeFile('analysis.md', `## Recommended actions
- Implement prompt guard for dispatch workers
- Document the prompt guard rollout
`);

    writeFile('TASKS.yaml', `tasks:
  - id: a1b2
    text: "Implement prompt guard for dispatch workers"
    why: "From demo/EXPERIMENTS — existing item"
    done-when: "Guard is live"
    priority: high
    status: open
    template: default
    plan: ""
`);

    const result = scanProjectRecommendations('', project, 30);

    assert.equal(result.scan_summary.files_scanned, 2);
    assert.equal(result.scan_summary.recommendations_found, 3);
    assert.equal(result.scan_summary.duplicates, 2);
    assert.equal(result.reflection_fields.length, 1);

    const actionable = result.candidates.filter((candidate) => !candidate.is_duplicate);
    assert.equal(actionable.length, 1);
    assert.equal(actionable.some((candidate) => /Document the prompt guard rollout/.test(candidate.text)), true);
  } finally {
    for (const f of files) { try { fs.unlinkSync(f); } catch {} }
    try { fs.rmdirSync(projectDir); } catch {}
  }
});

// --- help tests ---

import { runCli } from '../src/domain/tasks/recommendation/extractor.js';

test('recommendation-extractor --help returns help text', () => {
  const result = runCli(['--help']);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Options:/);
  assert.match(result.stdout, /--project/);
  assert.match(result.stdout, /--days/);
  assert.match(result.stdout, /Examples:/);
});
