// input:  CORTEX_VERSION, data/default paths, atomicWrite
// output: Versioned JSON and text file migrations
// pos:    Startup migration runner for user-owned files
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { CORTEX_VERSION, CORTEX_DOCS_URL } from '@core/version.js';
import { DATA_DIR, DEFAULTS_DIR } from '@core/paths.js';
import { atomicWrite } from '@core/atomic-write.js';
import { createLogger } from '@core/log.js';

const log = createLogger('version-migrations');

// ── CalVer comparison ──────────────────────────────────────────
// CalVer format: YYYY.M.D (no zero-padding, e.g. 2026.5.23).
// String comparison fails on cross-digit boundaries (2026.5.9 vs 2026.5.23)
// so we parse into numeric components and compare element-wise.
// Returns negative if a < b, positive if a > b, 0 if equal.

/** Strip -N suffix from CalVer strings so that "2026.5.24-1" → "2026.5.24". */
function stripSuffix(v: string): string {
  const dash = v.indexOf('-');
  return dash === -1 ? v : v.slice(0, dash);
}

export function compareCalVer(a: string, b: string): number {
  const [aYear, aMonth, aDay] = stripSuffix(a).split('.').map(Number);
  const [bYear, bMonth, bDay] = stripSuffix(b).split('.').map(Number);
  if (aYear !== bYear) return aYear - bYear;
  if (aMonth !== bMonth) return aMonth - bMonth;
  return aDay - bDay;
}

// ── Migration type ─────────────────────────────────────────────

export interface Migration {
  /** File path relative to DATA_DIR, e.g. "config/thread-templates.json". */
  filePath: string;
  /** CalVer when this migration was introduced. Compared against the per-file
   *  version tracked in versions.json to decide whether to run. */
  version: string;
  /** Target file format. 'json' (default) parses/serializes JSON; 'text' passes
   *  the raw file contents (string) through unchanged. Determines how the runner
   *  reads, diffs, and writes the file. */
  format?: 'json' | 'text';
  /** Idempotent migration function. For 'json' migrations, receives the parsed JSON
   *  of the target file and optionally the parsed JSON of the corresponding defaults
   *  file. For 'text' migrations, receives the raw file string and optionally the raw
   *  defaults string. Must return the migrated data (object for json, string for text)
   *  — the runner compares before/after to decide whether to write. */
  migrate(data: unknown, defaults?: unknown): unknown;
}

// ── Marker-block helpers (text migrations) ─────────────────────
// Text migrations edit human-owned markdown (system prompts, CORTEX.md) without
// clobbering user customizations: a versioned, marker-delimited block is upserted
// (replaced in place if present, appended otherwise). Bumping the block version token
// makes a future migration replace an older block cleanly.

const DOCS_BLOCK_VERSION = 'v1';
const DOCS_MARKER_START = `<!-- cortex:docs ${DOCS_BLOCK_VERSION} -->`;
const DOCS_MARKER_END = '<!-- /cortex:docs -->';

/** The canonical Cortex-docs block inserted into system prompts and CORTEX.md. */
const DOCS_BLOCK = [
  DOCS_MARKER_START,
  '# Cortex documentation',
  `For how to use Cortex — tasks, threads, scheduling, memory, skills, safety & approvals — consult the docs: ${CORTEX_DOCS_URL}`,
  DOCS_MARKER_END,
].join('\n');

/** Replace any existing `<!-- cortex:docs ... -->` … `<!-- /cortex:docs -->` region with
 *  `block`, or append `block` (separated by a blank line) when absent. Idempotent: feeding
 *  the output back in is a no-op. Matches any block version on the start marker so an old
 *  block is upgraded in place rather than duplicated. */
export function upsertMarkerBlock(content: string, block: string): string {
  const re = /<!-- cortex:docs[^>]*-->[\s\S]*?<!-- \/cortex:docs -->/;
  if (re.test(content)) {
    return content.replace(re, block);
  }
  const trimmed = content.replace(/\s+$/, '');
  return `${trimmed}\n\n${block}\n`;
}

/** Apply an ordered list of literal `[from, to]` replacements, each only when `from`
 *  is present in the content. Used by text migrations that neutralize opinionated or
 *  project-specific phrasing in shipped default prompts (e.g. a hard TDD mandate, a
 *  hardcoded `npm test`, a named lint tool) on existing installs whose prompt copies
 *  predate the edit. Idempotent provided no `to` re-introduces another rule's `from`:
 *  once replaced the `from` is gone, so re-runs are no-ops. A prompt the user has
 *  customized away from the shipped wording simply won't match and is left untouched,
 *  preserving their edits. */
export function applyReplacements(content: string, pairs: ReadonlyArray<readonly [string, string]>): string {
  let out = content;
  for (const [from, to] of pairs) {
    if (out.includes(from)) out = out.split(from).join(to);
  }
  return out;
}

// ── Directive-prompt neutralization tables (text migrations) ───
// The shipped coder / coder-reviewer directives baked in three non-portable
// assumptions that leaked Cortex's own toolchain into every install: a hard
// "TDD is non-negotiable" mandate, `npm test` as THE test command, and the
// dependency-cruiser linter named by brand. These tables rewrite that wording
// to be project-agnostic (test only if the project has a suite; use the project's
// own command; speak of lint/architecture checks generically). git-commit
// discipline is intentionally left in place — it is core to the Coder role's
// deliverable contract, not a personal preference.

const CODER_DIRECTIVE_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  [
    'TDD, reading before editing, and not improvising on ambiguous specs are cheaper than a re-run.',
    'Testing, reading before editing, and not improvising on ambiguous specs are cheaper than a re-run.',
  ],
  [
    '### TDD via `/develop`\n- Before implementing non-trivial logic, write a failing test.\n- Run the test, confirm it fails, implement, confirm it passes.\n- Trivial glue code and obvious one-liners are exempt; use judgment but bias toward tests.\n- Code that governs correctness (computation, data handling, seed handling) **requires** a test regardless.',
    '### Testing\n- Follow the project\'s existing testing practice. If the project has a test setup, add or update tests covering the logic you change. If the project practices test-driven development, write the failing test first, confirm it fails, implement, then confirm it passes.\n- Code that governs correctness (computation, data handling, seed handling) should be tested whenever the project provides a way to test it. Trivial glue code and obvious one-liners are exempt.\n- If the project has no test harness, verify by the means it already uses; do not scaffold a test framework unless the spec asks for it.',
  ],
  [
    '### Full-suite pass (non-negotiable)\n- After implementing and committing, run the project\'s full test suite (`npm test` or equivalent).\n- The full suite includes unit tests, architecture linters (e.g. dependency-cruiser), integration tests, and regression suites. Every stage must pass.\n- Do NOT commit or hand off until the full suite is green. A single red test or architecture violation means you are not done.\n- If the test suite had pre-existing failures before your invocation, note them explicitly in the implementation summary; you must still verify that no NEW failures were introduced by your changes.',
    '### Full-suite pass\n- If the project has a test suite, run it after implementing and committing, using whatever command the project defines (e.g. `npm test`, `pytest`, `make test`).\n- Run every stage the project configures — unit tests, linters or architecture checks, integration tests, regression suites. Every configured stage must pass.\n- Do NOT commit or hand off until the suite is green. A single red test or lint violation means you are not done.\n- If the suite had pre-existing failures before your invocation, note them explicitly in the implementation summary; you must still verify that no NEW failures were introduced by your changes.',
  ],
  [
    '3. Implement per spec. Use `/develop` for TDD on non-trivial logic.',
    '3. Implement per spec. If the project practices TDD, use `/develop` to drive it on non-trivial logic.',
  ],
  [
    '4. Run the **full test suite** (`npm test` or equivalent) locally; confirm every stage passes (architecture linter, unit tests, integration tests, regression suite). If it fails, fix before committing.',
    '4. If the project has a test suite, run it locally with the project\'s own command; confirm every configured stage passes (linters or architecture checks, unit tests, integration tests, regression suite). If it fails, fix before committing.',
  ],
  [
    '6. Run the full test suite one more time after committing to confirm the SHA is green.',
    '6. If the project has a test suite, run it once more after committing to confirm the SHA is green.',
  ],
  [
    '- **Partial test pass**: running only unit tests for the changed module while skipping integration tests, regression suites, or architecture linters. The full suite (`npm test`) must pass.',
    '- **Partial test pass**: running only unit tests for the changed module while skipping integration tests, regression suites, or lint/architecture checks the project configures. The project\'s full suite must pass when one exists.',
  ],
];

const CODER_REVIEWER_DIRECTIVE_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  [
    '### TDD discipline\nCoder must land tests alongside (or before) the implementation, with coverage over the spec\'s happy path **and** edge cases (boundaries, empty/null inputs, error paths, concurrency hazards relevant to the diff); missing tests, tests that don\'t exercise the new control-flow paths, or untested edge cases called out by the spec are **Blockers**.',
    '### Test discipline\nWhen the project has a test setup, Coder must land tests alongside (or before) the implementation, with coverage over the spec\'s happy path **and** edge cases (boundaries, empty/null inputs, error paths, concurrency hazards relevant to the diff); missing tests, tests that don\'t exercise the new control-flow paths, or untested edge cases called out by the spec are **Blockers**. If the project has no test harness, verify correctness by the means the project already uses and do not treat the absence of tests as a Blocker.',
  ],
  [
    '### Full-suite pass (non-negotiable)\nRun the project\'s full test suite (`npm test` or equivalent). This includes not just unit tests but also architecture linters, integration tests, and regression suites. **Any test failure or architecture violation (e.g. dependency-cruiser error) is a Blocker.** Do not rely on Coder\'s claim that tests passed — run them yourself. If the suite had pre-existing failures before this invocation, verify that no NEW failures were introduced; new failures are Blockers regardless of pre-existing state.',
    '### Full-suite pass\nIf the project has a test suite, run it using the project\'s own command (e.g. `npm test`, `pytest`, `make test`). This includes not just unit tests but also any linters or architecture checks, integration tests, and regression suites the project configures. **Any test failure or lint/architecture violation is a Blocker.** Do not rely on Coder\'s claim that tests passed — run them yourself. If the suite had pre-existing failures before this invocation, verify that no NEW failures were introduced; new failures are Blockers regardless of pre-existing state.',
  ],
  [
    '4. **Run the full test suite** (`npm test` or equivalent). Confirm that every stage passes: architecture linter, unit tests, integration tests, regression suite. If any test or lint stage fails, it is a Blocker — do not proceed to code review until Coder fixes it (or mark it as a pre-existing failure with evidence).',
    '4. **If the project has a test suite, run it** with the project\'s own command. Confirm that every configured stage passes: linters or architecture checks, unit tests, integration tests, regression suite. If any test or lint stage fails, it is a Blocker — do not proceed to code review until Coder fixes it (or mark it as a pre-existing failure with evidence).',
  ],
  [
    '- **Test run omission**: signing off on an implementation without running the full test suite yourself. Coder\'s claim that tests pass is not evidence. Run `npm test` and check every stage. A dependency-cruiser error or a test regression that Coder missed is as much your failure as theirs.',
    '- **Test run omission**: signing off on an implementation without running the project\'s test suite yourself when one exists. Coder\'s claim that tests pass is not evidence. Run the suite and check every stage. A lint/architecture error or a test regression that Coder missed is as much your failure as theirs.',
  ],
];

const PI_SUBAGENT_ROLE_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  ['subagent_type=Explore', 'subagent_type=explore'],
];

// ── Registry ───────────────────────────────────────────────────
// Add new migrations here. The runner groups them by filePath and applies
// pending ones in version-ascending order.

const migrations: Migration[] = [
  // M1: Backfill systemPrompt on user agents that are missing it.
  // Agents that exist in both user config and defaults, but whose user version
  // has no systemPrompt field, get the default agent's systemPrompt value copied.
  // Agents that already have systemPrompt are left untouched. User-only agents
  // (not in defaults) are skipped.
  {
    filePath: 'config/thread-templates.json',
    version: '2026.5.23',
    migrate(data: unknown, defaultsData?: unknown): unknown {
      if (!defaultsData || typeof defaultsData !== 'object' || defaultsData === null) return data;
      if (typeof data !== 'object' || data === null) return data;
      const d = data as Record<string, unknown>;
      const defs = defaultsData as Record<string, unknown>;
      const userAgents: Record<string, unknown> | undefined = d.agents as Record<string, unknown> | undefined;
      const defaultAgents: Record<string, unknown> | undefined = defs.agents as Record<string, unknown> | undefined;
      if (!userAgents || !defaultAgents) return data;

      let changed = false;
      for (const [name, defAgent] of Object.entries(defaultAgents)) {
        const userAgent = userAgents[name];
        if (!userAgent || typeof userAgent !== 'object') continue; // agent not in user config
        const ua = userAgent as Record<string, unknown>;
        const da = defAgent as Record<string, unknown>;
        if (ua.systemPrompt === undefined && da.systemPrompt !== undefined) {
          ua.systemPrompt = da.systemPrompt;
          changed = true;
        }
      }
      if (changed) d.agents = userAgents;
      return data;
    },
  },
  // M2: Backfill `provider` on pi profiles that predate the gateway-routing split (6e50225f).
  // That commit made `provider` REQUIRED for backend='pi' with no default — so any pre-upgrade
  // profiles.json with a pi profile lacking `provider` now fails the whole-file validation in
  // profile-manager (loadProfilesFile re-throws on ANY entry error → the entire config won't load
  // → agent-server can't start). Pre-split, the PI `--provider` was sourced from the profile's
  // `mode`, so `provider := mode` exactly reproduces the old behavior. Falls back to "anthropic"
  // (the PI adapter's own default) when `mode` is also absent. Idempotent: entries that already
  // declare `provider` are left untouched. Covers both primary entries and fallback[] entries,
  // mirroring profile-manager's effective-backend/mode inheritance (fallback inherits the primary's
  // backend and mode when its own are omitted).
  {
    filePath: 'config/profiles.json',
    version: '2026.5.25',
    migrate(data: unknown): unknown {
      if (typeof data !== 'object' || data === null || Array.isArray(data)) return data;
      const profiles = (data as Record<string, unknown>).profiles;
      if (typeof profiles !== 'object' || profiles === null || Array.isArray(profiles)) return data;

      const backfill = (entry: unknown, inheritedBackend: string, inheritedMode?: string): void => {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return;
        const e = entry as Record<string, unknown>;
        const backend = typeof e.backend === 'string' ? e.backend : inheritedBackend;
        if (backend !== 'pi' || e.provider !== undefined) return;
        const mode = typeof e.mode === 'string' ? e.mode : inheritedMode;
        e.provider = mode && mode.length > 0 ? mode : 'anthropic';
      };

      for (const entry of Object.values(profiles as Record<string, unknown>)) {
        backfill(entry, 'claude', undefined);
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
        const e = entry as Record<string, unknown>;
        const primaryBackend = typeof e.backend === 'string' ? e.backend : 'claude';
        const primaryMode = typeof e.mode === 'string' ? e.mode : undefined;
        if (Array.isArray(e.fallback)) {
          for (const fb of e.fallback) backfill(fb, primaryBackend, primaryMode);
        }
      }
      return data;
    },
  },
  // M3: Prefix session-store conduits with their platform namespace.
  // The multi-platform release made each adapter expose conduits in a canonical
  // prefixed form (`slack:C123`, `feishu:oc_xxx`) so Slack + Feishu + TUI can be
  // online simultaneously behind CompositeAdapter. sessions.json keys are
  // `backend:channel` (e.g. `claude:C123`) or legacy bare `channel`; after the
  // change, lookups use the prefixed conduit, so the old keys no longer resolve.
  // This migration rewrites the channel segment to its prefixed form so existing
  // sessions survive the upgrade. The platform is inferred from CORTEX_PLATFORM —
  // only run when EXACTLY ONE of slack/feishu is configured, since bare channels
  // cannot otherwise be attributed to a platform. TUI conduits (`tui-`/`tui:`)
  // and already-prefixed keys are left untouched (idempotent).
  {
    filePath: 'data/sessions.json',
    version: '2026.6.4',
    migrate(data: unknown): unknown {
      if (typeof data !== 'object' || data === null || Array.isArray(data)) return data;

      const platforms = (process.env.CORTEX_PLATFORM || 'slack')
        .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      const single = platforms.length === 1 ? platforms[0] : null;
      if (single !== 'slack' && single !== 'feishu') return data; // can't attribute bare channels
      const prefix = `${single}:`;

      const isPrefixed = (s: string): boolean => s.startsWith('slack:') || s.startsWith('feishu:');
      const isTui = (s: string): boolean => s.startsWith('tui-') || s.startsWith('tui:');

      const src = data as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(src)) {
        // Already-migrated legacy bare key (`slack:C2`) or a TUI conduit
        // (`tui-abc`): the whole key is already in canonical form. Backends are
        // claude/pi/tui — never `slack`/`feishu` — so a leading platform prefix
        // unambiguously means an already-prefixed bare key, not `backend:channel`.
        if (isPrefixed(key) || isTui(key)) { out[key] = val; continue; }
        const colon = key.indexOf(':');
        if (colon === -1) {
          // Legacy bare-channel key.
          out[`${prefix}${key}`] = val;
        } else {
          // `backend:channel` key — prefix the channel segment only.
          const backend = key.slice(0, colon);
          const channel = key.slice(colon + 1);
          out[isTui(channel) || isPrefixed(channel) ? key : `${backend}:${prefix}${channel}`] = val;
        }
      }
      return out;
    },
  },
  // M4: Inject the Cortex usage-docs block into the user's system prompts and CORTEX.md.
  // These are user-owned copies seeded at `cortex init` with force=false, so editing the
  // shipped defaults only reaches new installs — existing installs need this migration to
  // pick up the docs URL. Uses upsertMarkerBlock (text format) so the block is inserted
  // once and user customizations around it are preserved. Idempotent: re-runs are no-ops,
  // and fresh installs (whose seeded files already carry the block from defaults) match the
  // existing-block branch and are left unchanged. New files skip gracefully via ENOENT.
  ...[
    'CORTEX.md',
    'prompts/systemPrompts/direct.md',
    'prompts/systemPrompts/web.md',
    'prompts/systemPrompts/web-opus-4-6.md',
    'prompts/systemPrompts/web-sonnet-4-6.md',
    'prompts/systemPrompts/worker.md',
    'prompts/systemPrompts/coder.md',
  ].map((filePath): Migration => ({
    filePath,
    version: '2026.6.22',
    format: 'text',
    migrate(data: unknown): unknown {
      if (typeof data !== 'string') return data;
      return upsertMarkerBlock(data, DOCS_BLOCK);
    },
  })),
  // M5: De-personalize the coder / coder-reviewer directives. The shipped wording
  // hardcoded Cortex's own toolchain (a non-negotiable TDD mandate, `npm test` as THE
  // test command, the dependency-cruiser linter by name) — fine for this repo, wrong as
  // a default for every install. These two text migrations rewrite the user-owned prompt
  // copies under DATA_DIR/prompts/directives to project-agnostic phrasing. Idempotent via
  // applyReplacements (already-rewritten or user-customized copies don't match → no-op),
  // and missing files skip gracefully via ENOENT in the runner.
  {
    filePath: 'prompts/directives/coder.md',
    version: '2026.6.22-2',
    format: 'text',
    migrate(data: unknown): unknown {
      if (typeof data !== 'string') return data;
      return applyReplacements(data, CODER_DIRECTIVE_REPLACEMENTS);
    },
  },
  {
    filePath: 'prompts/directives/coder-reviewer.md',
    version: '2026.6.22-2',
    format: 'text',
    migrate(data: unknown): unknown {
      if (typeof data !== 'string') return data;
      return applyReplacements(data, CODER_REVIEWER_DIRECTIVE_REPLACEMENTS);
    },
  },
  // M6: Match existing prompt copies to PI's lowercase default role name.
  ...[
    'prompts/systemPrompts/direct.md',
    'prompts/systemPrompts/worker.md',
    'prompts/systemPrompts/coder.md',
  ].map((filePath): Migration => ({
    filePath,
    version: '2026.6.24',
    format: 'text',
    migrate(data: unknown): unknown {
      if (typeof data !== 'string') return data;
      return applyReplacements(data, PI_SUBAGENT_ROLE_REPLACEMENTS);
    },
  })),
];

// ── Versions file I/O ──────────────────────────────────────────

async function loadVersionsFrom(filePath: string): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      log.warn('versions.json has unexpected shape; resetting');
      return {};
    }
    return parsed as Record<string, string>;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      log.info('versions.json not found; all migrations will be considered pending');
      return {};
    }
    if (err instanceof SyntaxError) {
      log.warn(`Corrupt versions.json (${e.message}); resetting`);
      return {};
    }
    throw err;
  }
}

async function saveVersionsTo(filePath: string, versions: Record<string, string>): Promise<void> {
  await atomicWrite(filePath, JSON.stringify(versions, null, 2) + '\n');
}

// ── Defaults loader ────────────────────────────────────────────

/** Map of target filePath → corresponding defaults filePath (relative to DEFAULTS_DIR).
 *  When a migration needs defaults data, the runner looks up the defaults path here,
 *  reads it once, and passes it to every pending migration for that target file. */
const DEFAULTS_MAP: Record<string, string> = {
  'config/thread-templates.json': 'config/thread-templates.json',
};

async function loadDefaultsForWith(filePath: string, defaultsDir: string, format: 'json' | 'text' = 'json'): Promise<unknown> {
  const defaultsRel = DEFAULTS_MAP[filePath];
  if (!defaultsRel) return undefined;
  const defaultsPath = path.join(defaultsDir, defaultsRel);
  try {
    const raw = await fs.readFile(defaultsPath, 'utf8');
    return format === 'text' ? raw : JSON.parse(raw);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      log.warn(`Defaults file not found: ${defaultsPath}; migrations for ${filePath} may be skipped`);
    } else if (err instanceof SyntaxError) {
      log.warn(`Defaults file corrupt (${defaultsPath}): ${e.message}`);
    } else {
      log.warn(`Could not load defaults for ${filePath}: ${e.message}`);
    }
    return undefined;
  }
}

// ── Runner options ─────────────────────────────────────────────

export interface MigrationOptions {
  /** Override DATA_DIR (user config location). Defaults to the real CORTEX_HOME. */
  dataDir?: string;
  /** Override DEFAULTS_DIR (default config location). Defaults to INSTALL_ROOT/defaults. */
  defaultsDir?: string;
  /** Override versions.json location. Defaults to dataDir/data. */
  storeDir?: string;
}

// ── Runner ─────────────────────────────────────────────────────

export async function runMigrations(opts: MigrationOptions = {}): Promise<void> {
  const dataDir = opts.dataDir ?? DATA_DIR;
  const defaultsDir = opts.defaultsDir ?? DEFAULTS_DIR;
  const storeDir = opts.storeDir ?? path.join(dataDir, 'data');

  const versionsFile = path.join(storeDir, 'versions.json');
  const versions = await loadVersionsFrom(versionsFile);

  // Group migrations by filePath
  const byFilePath = new Map<string, Migration[]>();
  for (const m of migrations) {
    const list = byFilePath.get(m.filePath) ?? [];
    list.push(m);
    byFilePath.set(m.filePath, list);
  }

  for (const [filePath, fileMigrations] of byFilePath) {
    const trackedVersion = versions[filePath] || '0.0.0';

    // Pending: migrations whose version > trackedVersion and <= CORTEX_VERSION
    const pending = fileMigrations
      .filter(m => compareCalVer(trackedVersion, m.version) < 0 && compareCalVer(CORTEX_VERSION, m.version) >= 0)
      .sort((a, b) => compareCalVer(a.version, b.version));

    if (pending.length === 0) continue;

    // A file is either JSON or text — take the format from the pending migrations.
    const format: 'json' | 'text' = pending.find(m => m.format === 'text') ? 'text' : 'json';
    const serialize = (d: unknown): string => (format === 'text' ? String(d) : JSON.stringify(d));

    // Read target file
    const absPath = path.join(dataDir, filePath);
    let data: unknown;
    try {
      const raw = await fs.readFile(absPath, 'utf8');
      data = format === 'text' ? raw : JSON.parse(raw);
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        log.info(`Skipping migrations for ${filePath}: file does not exist yet`);
        continue;
      }
      if (err instanceof SyntaxError) {
        log.warn(`Skipping migrations for ${filePath}: corrupt JSON (${e.message})`);
        continue;
      }
      throw err;
    }

    // Load defaults once for this file (if any)
    const defaultsData = await loadDefaultsForWith(filePath, defaultsDir, format);

    // Apply all pending migrations in version order
    let changed = false;
    let anyFailed = false;
    for (const m of pending) {
      const before = serialize(data);
      try {
        data = m.migrate(data, defaultsData);
      } catch (err: unknown) {
        log.error(`Migration ${m.version} for ${filePath} failed: ${(err as Error).message}; skipping remaining migrations for this file`);
        changed = false;
        anyFailed = true;
        break;
      }
      if (serialize(data) !== before) {
        log.info(`Migration ${m.version} applied to ${filePath}`);
        changed = true;
      }
    }

    if (changed) {
      const out = format === 'text' ? String(data) : JSON.stringify(data, null, 2) + '\n';
      await atomicWrite(absPath, out);
    }

    // Only bump the tracked version if ALL pending migrations succeeded.
    // If any failed: we did not write the file (changed=false), so the data on
    // disk is unchanged. Leave version at the old value → all pending migrations
    // retry next boot. Idempotent migrations guarantee this is safe.
    if (!anyFailed) {
      versions[filePath] = pending[pending.length - 1].version;
    }
  }

  await saveVersionsTo(versionsFile, versions);
}

// ── File location migrations ───────────────────────────────────

/**
 * Migrate config.yaml from CORTEX_HOME/config/ (wrong location before 2026.6.11)
 * to ~/.aistatus/config.yaml (correct location read by aistatus).
 * Idempotent: if target already exists and is valid YAML, source is deleted without copying.
 * If source is malformed YAML, it's deleted to avoid interfering with aistatus.
 */
export async function migrateAistatusConfigLocation(dataDir: string): Promise<void> {
  const srcPath = path.join(dataDir, 'config', 'config.yaml');
  const dstPath = path.join(os.homedir(), '.aistatus', 'config.yaml');

  // Check if source exists
  let srcExists = false;
  try {
    await fs.access(srcPath);
    srcExists = true;
  } catch {
    // Source does not exist — nothing to migrate
    return;
  }

  // Check if target already exists
  let dstExists = false;
  let dstValid = false;
  try {
    await fs.access(dstPath);
    dstExists = true;
    // Validate target is readable YAML (not corrupted)
    const raw = await fs.readFile(dstPath, 'utf8');
    // Simple YAML validation: must be parseable as key: value pairs
    if (raw.trim().length === 0 || /^[a-zA-Z_][\w]*:/.test(raw)) {
      dstValid = true;
    }
  } catch {
    // Target does not exist or is not readable
  }

  // If target exists and is valid, source is redundant — just remove it
  if (dstExists && dstValid) {
    try {
      await fs.unlink(srcPath);
      log.info(`Migrated aistatus config: removed redundant ${srcPath} (target ${dstPath} already exists)`);
    } catch {
      // Best effort — if we can't delete, log warning but don't fail
      log.warn(`Could not remove old config file: ${srcPath}`);
    }
    return;
  }

  // Read source, validate, and copy to target
  let srcData: string;
  try {
    srcData = await fs.readFile(srcPath, 'utf8');
  } catch (err: unknown) {
    log.warn(`Could not read old config file: ${srcPath}; skipping migration`);
    return;
  }

  // Validate source is valid YAML before copying
  if (srcData.trim().length === 0 || !/^[a-zA-Z_][\w]*:/.test(srcData)) {
    // Source is empty or doesn't look like YAML — delete it to avoid pollution
    try {
      await fs.unlink(srcPath);
      log.info(`Removed malformed old config file: ${srcPath}`);
    } catch {
      log.warn(`Could not remove malformed old config file: ${srcPath}`);
    }
    return;
  }

  // Copy source to target
  try {
    const dstDir = path.dirname(dstPath);
    await fs.mkdir(dstDir, { recursive: true });
    await atomicWrite(dstPath, srcData);
    log.info(`Migrated aistatus config from ${srcPath} to ${dstPath}`);

    // Clean up source after successful copy
    try {
      await fs.unlink(srcPath);
    } catch {
      log.warn(`Could not remove old config file after migration: ${srcPath}`);
    }
  } catch (err: unknown) {
    log.error(`Failed to migrate aistatus config to ${dstPath}: ${(err as Error).message}`);
  }
}
