// input:  UiServiceDeps + MemoryTreeParams / MemoryFileParams
// output: handleMemoryTree → MemoryTree; handleMemoryFile → MemoryFile
// pos:    read-only fs query handlers for 'memory.tree' and 'memory.file'. All paths are
//         restricted to the project root (Project.contextDir under PROJECTS_DIR); traversal,
//         absolute paths, and symlink escape are rejected. No write API is used.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type {
  UiServiceDeps,
  MemoryTreeParams,
  MemoryFileParams,
  MemoryTree,
  MemoryFile,
  MemoryLineDiff,
  MemoryBlameLine,
} from '../types.js';

// Canonical top-level memory files, in display order. Missing ones are omitted (not errored).
const TOP_LEVEL_FILES = ['mission.md', 'roadmap.md', 'STATUS.md', 'TASKS.yaml'];
// Memory subdirectories whose `*.md` entries are counted (excluding the auto-generated index.md).
const MEMORY_DIRS = ['experiments', 'knowledge', 'patterns', 'decisions'];

function notFound(message: string): Error {
  return Object.assign(new Error(message), { code: 'not-found' });
}
function invalidArgs(message: string): Error {
  return Object.assign(new Error(message), { code: 'invalid-args' });
}

// Resolve the project's real (symlink-canonical) root directory, or throw not-found.
function resolveProjectRoot(deps: UiServiceDeps, projectId: string): string {
  const project = deps.projectStore.get(projectId);
  if (!project) throw notFound(`project not found: ${projectId}`);
  try {
    return fs.realpathSync(project.contextDir);
  } catch {
    throw notFound(`project directory not found: ${projectId}`);
  }
}

// True when `child` is `root` itself or strictly nested under it.
function isWithin(root: string, child: string): boolean {
  return child === root || child.startsWith(root + path.sep);
}

// Resolve a project-root-relative file path to an absolute path, rejecting absolute inputs,
// `..` traversal, non-files, and symlink escape (via realpath re-check). Read-only.
function resolveMemoryFilePath(realRoot: string, relPath: string): string {
  if (path.isAbsolute(relPath)) throw invalidArgs(`absolute path not allowed: ${relPath}`);

  const resolved = path.resolve(realRoot, relPath);
  if (!isWithin(realRoot, resolved)) throw invalidArgs(`path escapes project root: ${relPath}`);

  let real: string;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    throw notFound(`file not found: ${relPath}`);
  }
  // Symlink escape: the real (canonical) path must still live under the real root.
  if (!isWithin(realRoot, real)) throw invalidArgs(`path escapes project root: ${relPath}`);
  if (!fs.statSync(real).isFile()) throw invalidArgs(`not a file: ${relPath}`);
  return real;
}

export async function handleMemoryTree(
  deps: UiServiceDeps,
  params: MemoryTreeParams,
): Promise<MemoryTree> {
  const root = resolveProjectRoot(deps, params.projectId);

  const files = TOP_LEVEL_FILES.flatMap((name) => {
    const abs = path.join(root, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      return [];
    }
    if (!st.isFile()) return [];
    return [{ name, sizeBytes: st.size, modifiedAt: st.mtime.toISOString() }];
  });

  const dirs = MEMORY_DIRS.flatMap((name) => {
    const abs = path.join(root, name);
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return [];
    }
    const entries = dirents
      .filter(
        (e) => e.isFile() && e.name.endsWith('.md') && e.name !== 'index.md' && e.name !== 'CORTEX.md',
      )
      .map((e) => {
        const st = fs.statSync(path.join(abs, e.name));
        return { name: e.name, sizeBytes: st.size, modifiedAt: st.mtime.toISOString() };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return [{ name, entryCount: entries.length, entries }];
  });

  return { projectId: params.projectId, files, dirs };
}

// Real working-tree-vs-HEAD line counts via `git diff --numstat`. Returns null (honest placeholder,
// never fabricated) when the project dir is not a git work tree, git is unavailable, or the diff is
// binary/unresolvable. Read-only; array args (no shell) — `relPath` is the already-validated
// project-relative path, so there is no injection surface.
function gitLineDiff(root: string, relPath: string): MemoryLineDiff | null {
  let out: string;
  try {
    out = execFileSync('git', ['diff', '--numstat', 'HEAD', '--', relPath], {
      cwd: root,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch {
    // git missing / not a repo / non-zero exit → unknown, not fabricated.
    return null;
  }
  const line = out.split('\n').find((l) => l.trim().length > 0);
  // No diff vs HEAD (e.g. a clean auto-committed file) → the real answer is 0/0.
  if (!line) return { added: 0, removed: 0 };
  const [addedRaw, removedRaw] = line.split('\t');
  // Binary files report `-\t-\t<path>` → counts are unknowable, honest null.
  const added = Number(addedRaw);
  const removed = Number(removedRaw);
  if (!Number.isFinite(added) || !Number.isFinite(removed)) return null;
  return { added, removed };
}

// Extract a task reference (4-hex id) from a commit subject. A ref is only recognized when it is
// anchored to a `task` / `manager` / `gate` keyword — bare 4-hex tokens (or 4-digit years) are NOT
// assumed to be refs, so an unsourced line stays an honest `null` rather than a fabricated ref.
const TASK_REF_RE = /\b(?:task|manager|gate)\s+([0-9a-f]{4})\b/i;
export function parseTaskRef(subject: string): string | null {
  const m = TASK_REF_RE.exec(subject);
  return m ? m[1].toLowerCase() : null;
}

// Parse `git blame --line-porcelain` output into per-line attribution. Each line group starts with a
// `<40-hex> <origLine> <finalLine> [<n>]` header, carries a `summary <subject>` field, and ends with
// the TAB-prefixed content line. The commit hash is shortened to 8 hex; the subject → parseTaskRef.
export function parseBlamePorcelain(out: string): MemoryBlameLine[] {
  const rows: MemoryBlameLine[] = [];
  // git emits the full commit header (incl. `summary`) only the FIRST time a commit is seen;
  // later lines of the same commit carry only the abbreviated header + content. Cache the parsed
  // task ref per commit so repeated lines keep their ref.
  const refByCommit = new Map<string, string | null>();
  let commit: string | null = null;
  let lineNo = 0;
  for (const raw of out.split('\n')) {
    if (raw.startsWith('\t')) {
      // Content line closes the current group.
      if (commit) {
        rows.push({ line: lineNo, commit: commit.slice(0, 8), taskRef: refByCommit.get(commit) ?? null });
      }
      commit = null;
      continue;
    }
    const header = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(raw);
    if (header) {
      commit = header[1];
      lineNo = Number(header[2]);
      continue;
    }
    if (commit && raw.startsWith('summary ')) {
      refByCommit.set(commit, parseTaskRef(raw.slice('summary '.length)));
    }
  }
  return rows;
}

// Real per-line blame (commit hash + parsed task ref). Returns null (honest placeholder, never
// fabricated) when the project dir is not a git work tree, git is unavailable, or the file is
// binary/unblameable. Read-only; array args (no shell) — `relPath` is already validated.
function gitBlame(root: string, relPath: string): MemoryBlameLine[] | null {
  let out: string;
  try {
    out = execFileSync('git', ['blame', '--line-porcelain', 'HEAD', '--', relPath], {
      cwd: root,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch {
    // git missing / not a repo / binary / non-zero exit → unknown, not fabricated.
    return null;
  }
  return parseBlamePorcelain(out);
}

export async function handleMemoryFile(
  deps: UiServiceDeps,
  params: MemoryFileParams,
): Promise<MemoryFile> {
  const root = resolveProjectRoot(deps, params.projectId);
  const abs = resolveMemoryFilePath(root, params.path);

  const st = fs.statSync(abs);
  const content = fs.readFileSync(abs, 'utf8');
  return {
    projectId: params.projectId,
    path: params.path,
    content,
    sizeBytes: st.size,
    modifiedAt: st.mtime.toISOString(),
    lineDiff: gitLineDiff(root, params.path),
    blame: gitBlame(root, params.path),
  };
}
