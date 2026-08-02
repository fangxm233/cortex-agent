// input:  PROJECTS_DIR (from @core/paths.js or constructor arg)
// output: ProjectStore — list / get / exists / getDefault / resolveFromMessage / refresh
//         + createProject(name) (validated scaffold of a new user project)
//         + auto-scaffold of general/ project on first initialize()
// pos:    Read-only project registry with fs.watch cache invalidation
//         "general" is always synthesized; never persisted.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROJECTS_DIR } from '@core/paths.js';
import { createLogger } from '@core/log.js';
import type { Project } from './project-types.js';

const log = createLogger('project-store');

const DEBOUNCE_MS = 1000;
/** STATUS.md scaffold following the state-register skeleton (rules/status-md.md). */
function scaffoldStatus(id: string, situation: string, nextStep: string): string {
  return [
    `# ${id} Status`,
    '',
    'Updated: —',
    '',
    '## Current Situation',
    situation,
    '',
    '## In Flight & New Variables',
    'none',
    '',
    '## Blockers & Pending Decisions',
    'none',
    '',
    '## Next Step',
    nextStep,
    '',
  ].join('\n');
}

const GENERAL_SCAFFOLD_STATUS = scaffoldStatus(
  'general',
  'Synthetic umbrella project — collects work not scoped to a specific project.',
  'none',
);
const GENERAL_SCAFFOLD_CORTEX = `# general

Synthetic umbrella project — always present. Created automatically by the system.
`;

/** A single safe path segment: no separators, no '..', no leading dot. */
const VALID_PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Result of a createProject attempt (local to the store; the ui-service handler maps it). */
export type CreateProjectResult =
  | { ok: true; project: Project }
  | { ok: false; code: 'invalid-name' | 'already-exists'; message: string };

export interface ProjectStoreOptions {
  /** Overrideable for tests. Defaults to PROJECTS_DIR from @core/paths. */
  projectsDir?: string;
  /** Disable fs.watch — for tests that manipulate dirs synchronously. Defaults to true. */
  watchEnabled?: boolean;
}

export class ProjectStore {
  private readonly projectsDir: string;
  private readonly watchEnabled: boolean;
  private projects: Project[] = [];
  private initialized = false;
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: ProjectStoreOptions = {}) {
    this.projectsDir = opts.projectsDir ?? PROJECTS_DIR;
    this.watchEnabled = opts.watchEnabled ?? true;
  }

  /**
   * Scan PROJECTS_DIR, scaffold general if absent, build cache, start watcher.
   * Idempotent — safe to call multiple times.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.scaffoldGeneral();
    this.scan();
    this.initialized = true;

    if (this.watchEnabled) {
      this.startWatcher();
    }

    log.info(`ProjectStore initialized: ${this.projects.length} projects (${this.projectsDir})`);
  }

  /** Return all known projects. Always includes "general". */
  list(): Project[] {
    return [...this.projects];
  }

  /** Look up a project by id. Returns undefined for unknown ids. */
  get(id: string): Project | undefined {
    return this.projects.find((p) => p.id === id);
  }

  /** True if a project with the given id exists. */
  exists(id: string): boolean {
    return this.projects.some((p) => p.id === id);
  }

  /** Return the "general" umbrella project. Always present. */
  getDefault(): Project {
    // Guaranteed to exist after initialize()
    return this.projects.find((p) => p.kind === 'general')!;
  }

  /**
   * Resolve a project from a message string using heuristic patterns.
   *
   * Priority:
   *   1. [project:xxx] explicit tag — always wins
   *   2. Case-insensitive substring match against scanned project ids
   *      (longest match wins when multiple project names appear in the message)
   *   3. 'general' fallback
   *
   * Returns the matching Project or the default general project.
   */
  resolveFromMessage(msg: string | null | undefined): Project | null {
    if (!msg) return this.getDefault();

    // 1. [project:xxx] tag — always wins
    const tagMatch = msg.match(/\[project:([^\]]+)\]/);
    if (tagMatch) return this.get(tagMatch[1]) ?? this.getDefault();

    // 2. Case-insensitive substring match (longest project id wins)
    const lower = msg.toLowerCase();
    let bestMatch: Project | null = null;
    let bestLen = 0;
    for (const project of this.projects) {
      if (project.kind === 'general') continue;
      const lowerName = project.id.toLowerCase();
      if (lower.includes(lowerName) && project.id.length > bestLen) {
        bestMatch = project;
        bestLen = project.id.length;
      }
    }

    // 3. Fallback
    return bestMatch ?? this.getDefault();
  }

  /** Force a rescan of PROJECTS_DIR (e.g. after watcher event or manual trigger). */
  refresh(): void {
    this.scan();
  }

  /**
   * Create a new user project directory under PROJECTS_DIR with a standard scaffold
   * (STATUS.md + CORTEX.md). Validates the name (rejects path traversal, separators,
   * empty/whitespace, leading-dot, and the reserved 'general'). Never overwrites an
   * existing project directory — returns an `already-exists` error instead.
   */
  createProject(name: string): CreateProjectResult {
    const id = typeof name === 'string' ? name.trim() : '';
    if (!id || id === 'general' || !VALID_PROJECT_NAME.test(id) || path.basename(id) !== id) {
      return {
        ok: false,
        code: 'invalid-name',
        message: `Invalid project name: ${JSON.stringify(name)}`,
      };
    }

    const projectDir = path.join(this.projectsDir, id);
    if (this.exists(id) || fs.existsSync(projectDir)) {
      return { ok: false, code: 'already-exists', message: `Project already exists: ${id}` };
    }

    this.scaffoldProject(
      projectDir,
      scaffoldStatus(id, 'New project — not yet oriented.', 'Define mission.md and roadmap.md.'),
      `# ${id}\n\n${id} project.\n`,
    );
    log.info(`Created project at ${projectDir}`);

    // Refresh the cache so the new project is immediately visible.
    this.scan();
    const project = this.get(id);
    if (!project) {
      return { ok: false, code: 'invalid-name', message: `Project not registered after creation: ${id}` };
    }
    return { ok: true, project };
  }

  /** Stop the fs.watch watcher and release resources. */
  destroy(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.initialized = false;
  }

  // ── Private ──────────────────────────────────────────────────

  /** Create general/ scaffold if the directory does not exist. */
  private scaffoldGeneral(): void {
    const generalDir = path.join(this.projectsDir, 'general');
    if (fs.existsSync(generalDir)) return;

    this.scaffoldProject(generalDir, GENERAL_SCAFFOLD_STATUS, GENERAL_SCAFFOLD_CORTEX);
    log.info(`Scaffolded general project at ${generalDir}`);
  }

  /** Create a project directory and write the standard scaffold files (STATUS.md + CORTEX.md). */
  private scaffoldProject(dir: string, statusContent: string, cortexContent: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'STATUS.md'), statusContent, 'utf8');
    fs.writeFileSync(path.join(dir, 'CORTEX.md'), cortexContent, 'utf8');
  }

  /** Read PROJECTS_DIR and rebuild the in-memory cache. */
  private scan(): void {
    const result: Project[] = [];

    // Always synthesize "general"
    result.push(this.makeGeneralProject());

    // Enumerate real project directories
    try {
      const entries = fs.readdirSync(this.projectsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue;
        if (entry.name === 'general') continue; // already added
        result.push({
          id: entry.name,
          name: entry.name,
          kind: 'user',
          contextDir: path.join(this.projectsDir, entry.name),
        });
      }
    } catch {
      // PROJECTS_DIR missing or unreadable — only "general" will be present
    }

    this.projects = result;
  }

  private makeGeneralProject(): Project {
    return {
      id: 'general',
      name: 'general',
      kind: 'general',
      contextDir: path.join(this.projectsDir, 'general'),
    };
  }

  /** Watch PROJECTS_DIR for add/remove of subdirectories. */
  private startWatcher(): void {
    try {
      this.watcher = fs.watch(this.projectsDir, (eventType, filename) => {
        // On Linux 'rename' fires for create/delete; filter to directory-relevant events
        if (!filename) return;
        // Ignore events for dotfiles and non-directory files (we can't easily check
        // what type the changed entry is from the event alone, so we just debounce-scan)
        if (filename.startsWith('.')) return;

        this.debouncedRescan();
      });

      this.watcher.on('error', (err) => {
        log.error(`Watcher error for ${this.projectsDir}:`, err.message);
      });
    } catch (err) {
      log.error(`Failed to start watcher for ${this.projectsDir}:`, err);
    }
  }

  private debouncedRescan(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.scan();
      log.debug(`Rescanned projects after directory change`);
    }, DEBOUNCE_MS);
  }
}

// --- Singleton ---

export const projectStore = new ProjectStore();
