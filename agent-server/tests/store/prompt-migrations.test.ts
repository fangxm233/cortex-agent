// input:  Vitest, temporary prompt files, shipped defaults
// output: Directive prompt migration policy regressions
// pos:    Verifies versioned coder directive text migrations
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const { runMigrations } = await import('../../src/store/version-migrations.js');
const { DEFAULTS_DIR } = await import('../../src/core/paths.js');

let tmpDir: string;
let testIndex = 0;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-prompt-migrations-test-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function setupDirs(): { dataDir: string; storeDir: string; defaultsDir: string } {
  const dataDir = path.join(tmpDir, `data-${testIndex++}`);
  return {
    dataDir,
    storeDir: path.join(dataDir, 'data'),
    defaultsDir: path.join(dataDir, 'defaults'),
  };
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function writeText(filePath: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, data);
}

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8');
}

const OLD_CODER_DIRECTIVE = [
  '# Identity',
  '- **Cost**: wrong code silently burns downstream compute. TDD, reading before editing, and not improvising on ambiguous specs are cheaper than a re-run.',
  '',
  '### TDD via `/develop`',
  '- Before implementing non-trivial logic, write a failing test.',
  '- Run the test, confirm it fails, implement, confirm it passes.',
  '- Trivial glue code and obvious one-liners are exempt; use judgment but bias toward tests.',
  '- Code that governs correctness (computation, data handling, seed handling) **requires** a test regardless.',
  '',
  '### Full-suite pass (non-negotiable)',
  "- After implementing and committing, run the project's full test suite (`npm test` or equivalent).",
  '- The full suite includes unit tests, architecture linters (e.g. dependency-cruiser), integration tests, and regression suites. Every stage must pass.',
  '- Do NOT commit or hand off until the full suite is green. A single red test or architecture violation means you are not done.',
  '- If the test suite had pre-existing failures before your invocation, note them explicitly in the implementation summary; you must still verify that no NEW failures were introduced by your changes.',
  '',
  '3. Implement per spec. Use `/develop` for TDD on non-trivial logic.',
  '4. Run the **full test suite** (`npm test` or equivalent) locally; confirm every stage passes (architecture linter, unit tests, integration tests, regression suite). If it fails, fix before committing.',
  '6. Run the full test suite one more time after committing to confirm the SHA is green.',
  '- **Partial test pass**: running only unit tests for the changed module while skipping integration tests, regression suites, or architecture linters. The full suite (`npm test`) must pass.',
  '- Commit your implementation **before** handing off. Git discipline is preserved.',
].join('\n') + '\n';

const OLD_CODER_REVIEWER_DIRECTIVE = [
  '# Identity',
  '### TDD discipline',
  "Coder must land tests alongside (or before) the implementation, with coverage over the spec's happy path **and** edge cases (boundaries, empty/null inputs, error paths, concurrency hazards relevant to the diff); missing tests, tests that don't exercise the new control-flow paths, or untested edge cases called out by the spec are **Blockers**.",
  '',
  '### Full-suite pass (non-negotiable)',
  "Run the project's full test suite (`npm test` or equivalent). This includes not just unit tests but also architecture linters, integration tests, and regression suites. **Any test failure or architecture violation (e.g. dependency-cruiser error) is a Blocker.** Do not rely on Coder's claim that tests passed — run them yourself. If the suite had pre-existing failures before this invocation, verify that no NEW failures were introduced; new failures are Blockers regardless of pre-existing state.",
  '',
  '4. **Run the full test suite** (`npm test` or equivalent). Confirm that every stage passes: architecture linter, unit tests, integration tests, regression suite. If any test or lint stage fails, it is a Blocker — do not proceed to code review until Coder fixes it (or mark it as a pre-existing failure with evidence).',
  "- **Test run omission**: signing off on an implementation without running the full test suite yourself. Coder's claim that tests pass is not evidence. Run `npm test` and check every stage. A dependency-cruiser error or a test regression that Coder missed is as much your failure as theirs.",
].join('\n') + '\n';

const OLD_REVIEWER_COMMIT_POLICY = [
  '# Identity',
  '',
  '## Preconditions',
  '- The spec is fixed (not being concurrently edited).',
  '- `git log` shows at least one commit attributable to this invocation.',
  '',
  '### Git discipline',
  '- Commits must land **before** the handoff boundary (before Engineer launches, before QA reviews, before the thread ends). Uncommitted changes at handoff are **Blockers**.',
  '- Commit message must reference the spec identifier (EXP ID, task ID, issue reference). Missing reference is a **Blocker** in research mode; **Nice-to-have** in generic mode unless a task ID was clearly available.',
  '- `--no-verify`, `--no-gpg-sign`, or any hook bypass is a **Blocker**; hook failures must be root-caused.',
  '- Force-push, `git reset --hard`, or `rm -rf` on shared paths without explicit user authorization is a **Blocker**.',
  '',
  '### Config in-repo',
  'Committed configuration.',
  '',
  '## Procedural requirements',
  '6. Check commit messages for spec-identifier references.',
].join('\n') + '\n';
const OLD_PUBLIC_REVIEWER_COMMIT_POLICY = OLD_REVIEWER_COMMIT_POLICY
  .replace('before Engineer launches', 'before downstream consumers run it')
  .replace(
    '- Commit message must reference the spec identifier (EXP ID, task ID, issue reference). Missing reference is a **Blocker** in research mode; **Nice-to-have** in generic mode unless a task ID was clearly available.',
    '- Commit message should reference the spec identifier (task ID, issue reference) when one is clearly available; missing reference is a **Nice-to-have**.',
  )
  .replace('6. Check commit messages', '7. Check commit messages');

function markdownSection(content: string, heading: string, nextHeading: string): string {
  const start = content.indexOf(heading);
  const end = content.indexOf(nextHeading, start);
  assert.ok(start >= 0 && end > start, `missing section ${heading}`);
  return content.slice(start, end).trim();
}

test('runMigrations de-personalizes the coder directive', async () => {
  const { dataDir, storeDir, defaultsDir } = setupDirs();
  const target = path.join(dataDir, 'prompts', 'directives', 'coder.md');
  await writeText(target, OLD_CODER_DIRECTIVE);

  await runMigrations({ dataDir, defaultsDir, storeDir });

  const out = await readText(target);
  assert.ok(!out.includes('### TDD via `/develop`'));
  assert.ok(!out.includes('(non-negotiable)'));
  assert.ok(!out.includes('dependency-cruiser'));
  assert.ok(!out.includes('**requires** a test regardless'));
  assert.ok(out.includes('### Testing'));
  assert.ok(out.includes('If the project has a test suite'));
  assert.ok(out.includes('`pytest`'));
  assert.ok(out.includes('Git discipline is preserved.'));
  const versions = await readJson(path.join(storeDir, 'versions.json')) as any;
  assert.equal(versions['prompts/directives/coder.md'], '2026.6.22-2');
});

test('runMigrations de-personalizes the coder-reviewer directive', async () => {
  const { dataDir, storeDir, defaultsDir } = setupDirs();
  const target = path.join(dataDir, 'prompts', 'directives', 'coder-reviewer.md');
  await writeText(target, OLD_CODER_REVIEWER_DIRECTIVE);

  await runMigrations({ dataDir, defaultsDir, storeDir });

  const out = await readText(target);
  assert.ok(!out.includes('### TDD discipline'));
  assert.ok(!out.includes('(non-negotiable)'));
  assert.ok(!out.includes('dependency-cruiser'));
  assert.ok(out.includes('### Test discipline'));
  assert.ok(out.includes('If the project has a test suite'));
  const versions = await readJson(path.join(storeDir, 'versions.json')) as any;
  assert.equal(versions['prompts/directives/coder-reviewer.md'], '2026.7.30');
});

test.each([
  ['research-oriented', OLD_REVIEWER_COMMIT_POLICY],
  ['generic public', OLD_PUBLIC_REVIEWER_COMMIT_POLICY],
])('runMigrations aligns %s coder-review attribution with repository policy', async (_name, legacyPolicy) => {
  const { dataDir, storeDir, defaultsDir } = setupDirs();
  const relativePath = 'prompts/directives/coder-reviewer.md';
  const target = path.join(dataDir, relativePath);
  await writeText(target, legacyPolicy);
  await writeJson(path.join(storeDir, 'versions.json'), { [relativePath]: '2026.6.22-2' });

  await runMigrations({ dataDir, defaultsDir, storeDir });
  const first = await readText(target);
  const shipped = await readText(path.join(DEFAULTS_DIR, relativePath));

  assert.equal(
    markdownSection(first, '### Git discipline', '### Config in-repo'),
    markdownSection(shipped, '### Git discipline', '### Config in-repo'),
  );
  assert.ok(first.includes('Missing or unverifiable attribution is a **Blocker**'));
  assert.ok(first.includes('Uncommitted changes at handoff are **Blockers**'));
  assert.ok(first.includes('must not be treated as a Blocker'));
  assert.ok(first.includes('must not require a metadata-only follow-up commit'));
  assert.ok(!first.includes('Missing reference is a **Blocker**'));

  await runMigrations({ dataDir, defaultsDir, storeDir });
  assert.equal(await readText(target), first, 'second run must be byte-identical');
  const versions = await readJson(path.join(storeDir, 'versions.json')) as any;
  assert.equal(versions[relativePath], '2026.7.30');
});

test('runMigrations leaves customized directive policies untouched', async () => {
  const { dataDir, storeDir, defaultsDir } = setupDirs();
  const relativePath = 'prompts/directives/coder-reviewer.md';
  const target = path.join(dataDir, relativePath);
  const customized = '# Identity\nOur release ledger defines commit attribution.\n';
  await writeText(target, customized);
  await writeJson(path.join(storeDir, 'versions.json'), { [relativePath]: '2026.6.22-2' });

  await runMigrations({ dataDir, defaultsDir, storeDir });

  assert.equal(await readText(target), customized);
  const versions = await readJson(path.join(storeDir, 'versions.json')) as any;
  assert.equal(versions[relativePath], '2026.7.30');
});

test('runMigrations keeps coder directive migration idempotent', async () => {
  const { dataDir, storeDir, defaultsDir } = setupDirs();
  const target = path.join(dataDir, 'prompts', 'directives', 'coder.md');
  await writeText(target, OLD_CODER_DIRECTIVE);

  await runMigrations({ dataDir, defaultsDir, storeDir });
  const first = await readText(target);
  await runMigrations({ dataDir, defaultsDir, storeDir });

  assert.equal(await readText(target), first);
});

test('runMigrations leaves customized coder directives untouched', async () => {
  const { dataDir, storeDir, defaultsDir } = setupDirs();
  const target = path.join(dataDir, 'prompts', 'directives', 'coder.md');
  const customized = '# Identity\nMy team does not do TDD. Run `cargo test` when convenient.\n';
  await writeText(target, customized);

  await runMigrations({ dataDir, defaultsDir, storeDir });

  assert.equal(await readText(target), customized);
});
