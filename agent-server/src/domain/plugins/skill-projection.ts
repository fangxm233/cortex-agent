// input:  validated portable skill directories
// output: snapshots, copies, and exact validators
// pos:    Recursive portable skill projection helpers
//
// Change detection is stat-based on purpose: every projected file used to be read and sha256'd
// three times per spawn (build, copy, validate). The source-side guarantees — symlink containment,
// torn reads, "changed after validation" — hold on the identity of the inode (dev/ino) plus its
// stat signature (size, mtime, ctime, mode), which any content write or replacement moves. A
// materialized copy has its own inode and timestamps, so it is compared on path + byte length +
// mode + directory set. File bytes are never hashed.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { containsPath } from './fs-helpers.js';

export interface ProjectedSkillFile {
  path: string;
  /** Source identity (size, mtime, ctime, inode, mode) — what the copy re-validates against. */
  signature: string;
  /** Byte length of the source file; a materialized copy must match it. */
  size: number;
  mode: number;
}

export interface ProjectedSkillTree {
  dirs: string[];
  files: ProjectedSkillFile[];
  /** Digest of the {dirs, files} descriptor (metadata only), used as the projection cache key. */
  sha256: string;
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeRealpath(root: string, filePath: string): string {
  const resolved = fs.realpathSync(filePath);
  if (!containsPath(root, resolved)) throw new Error(`Skill path escapes plugin root: ${filePath}`);
  return resolved;
}

function assertRegularFile(stat: fs.Stats, filePath: string): void {
  if (!stat.isFile()) throw new Error(`Skill path is not a file: ${filePath}`);
}

function assertSameFile(expected: fs.Stats, actual: fs.Stats, filePath: string): void {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino) {
    throw new Error(`Skill file changed while being read: ${filePath}`);
  }
}

/** Stable identity of a file without reading its bytes: any content write moves mtime/ctime,
 *  and any replacement moves the inode. */
function statSignature(stat: fs.Stats): string {
  return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}:${stat.mode & 0o777}`;
}

const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);

/** Open a file through its realpath with O_NOFOLLOW and assert the inode did not change under us.
 *  Returns the open fd plus the validated stat — callers either stat it or read from it. */
function openStableFile(root: string, filePath: string): { fd: number; stat: fs.Stats } {
  const resolved = safeRealpath(root, filePath);
  const fd = fs.openSync(resolved, OPEN_FLAGS);
  try {
    const opened = fs.fstatSync(fd);
    assertRegularFile(opened, resolved);
    // A symlink swapped in between realpath() and open() must be caught. lstat avoids a second
    // realpath walk (the most expensive syscall here): for the regular file we expect, lstat and
    // stat agree; a swapped-in symlink reports its own inode and mismatches.
    assertSameFile(opened, fs.lstatSync(filePath), filePath);
    return { fd, stat: fs.fstatSync(fd) };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function pushFile(
  packageRoot: string,
  files: ProjectedSkillFile[],
  filePath: string,
  relativePath: string,
): void {
  const { fd, stat } = openStableFile(packageRoot, filePath);
  try {
    files.push({
      path: relativePath,
      signature: statSignature(stat),
      size: stat.size,
      mode: stat.mode & 0o777,
    });
  } finally {
    fs.closeSync(fd);
  }
}

function scanDirectory(
  packageRoot: string,
  logicalPath: string,
  relativePath: string,
  stack: Set<string>,
  dirs: string[],
  files: ProjectedSkillFile[],
): void {
  const real = safeRealpath(packageRoot, logicalPath);
  if (stack.has(real)) throw new Error(`Skill tree contains a symlink cycle: ${relativePath || '.'}`);
  const next = new Set(stack).add(real);
  if (relativePath) dirs.push(relativePath);
  for (const name of fs.readdirSync(logicalPath).sort()) {
    scanNode(packageRoot, path.join(logicalPath, name), path.posix.join(relativePath, name), next, dirs, files);
  }
}

function scanSymlink(
  packageRoot: string,
  logicalPath: string,
  relativePath: string,
  stack: Set<string>,
  dirs: string[],
  files: ProjectedSkillFile[],
): void {
  const real = safeRealpath(packageRoot, logicalPath);
  const target = fs.statSync(real);
  if (target.isDirectory()) return scanDirectory(packageRoot, real, relativePath, stack, dirs, files);
  if (target.isFile()) return pushFile(packageRoot, files, real, relativePath);
  throw new Error(`Skill path is not a file or directory: ${relativePath}`);
}

function scanNode(
  packageRoot: string,
  logicalPath: string,
  relativePath: string,
  stack: Set<string>,
  dirs: string[],
  files: ProjectedSkillFile[],
): void {
  const stat = fs.lstatSync(logicalPath);
  if (stat.isSymbolicLink()) {
    return scanSymlink(packageRoot, logicalPath, relativePath, stack, dirs, files);
  }
  if (stat.isDirectory()) return scanDirectory(packageRoot, logicalPath, relativePath, stack, dirs, files);
  if (stat.isFile()) return pushFile(packageRoot, files, logicalPath, relativePath);
  throw new Error(`Skill path is not a file or directory: ${relativePath}`);
}

function treeSha256(dirs: string[], files: ProjectedSkillFile[]): string {
  return sha256(JSON.stringify({ dirs, files }));
}

export function buildProjectedSkillTree(packageRoot: string, skillRoot: string): ProjectedSkillTree {
  const dirs: string[] = [];
  const files: ProjectedSkillFile[] = [];
  scanDirectory(fs.realpathSync(packageRoot), skillRoot, '', new Set<string>(), dirs, files);
  dirs.sort();
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { dirs, files, sha256: treeSha256(dirs, files) };
}

function ensureDir(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function copyFile(
  packageRoot: string,
  source: string,
  target: string,
  expected: ProjectedSkillFile,
  requireSourceSignature: boolean,
): void {
  const { fd, stat } = openStableFile(packageRoot, source);
  try {
    if (requireSourceSignature && statSignature(stat) !== expected.signature) {
      throw new Error(`Skill file changed after validation: ${source}`);
    }
    // Byte length + mode are the descriptor-level contract for every copy; a same-length in-place
    // rewrite is only distinguishable through the full signature, which the plugin-source copy
    // enforces above. Copies taken from an already validated snapshot carry that snapshot's own
    // timestamps, so they compare on shape.
    if (stat.size !== expected.size || (stat.mode & 0o777) !== expected.mode) {
      throw new Error(`Skill file changed after validation: ${source}`);
    }
    const bytes = fs.readFileSync(fd);
    // No second read: the inode must be the one we opened, unchanged by the read itself.
    const after = fs.fstatSync(fd);
    assertSameFile(stat, after, source);
    if (after.size !== expected.size || statSignature(after) !== statSignature(stat)) {
      throw new Error(`Skill file changed while being read: ${source}`);
    }
    fs.writeFileSync(target, bytes, { mode: expected.mode });
    fs.chmodSync(target, expected.mode);
  } finally {
    fs.closeSync(fd);
  }
}

export function copyProjectedSkillTree(
  packageRoot: string,
  skillRoot: string,
  tree: ProjectedSkillTree,
  targetRoot: string,
  opts: { requireSourceSignature?: boolean } = {},
): void {
  ensureDir(targetRoot);
  for (const dir of tree.dirs) ensureDir(path.join(targetRoot, dir));
  for (const file of tree.files) {
    ensureDir(path.dirname(path.join(targetRoot, file.path)));
    copyFile(
      packageRoot, path.join(skillRoot, file.path), path.join(targetRoot, file.path), file,
      opts.requireSourceSignature === true,
    );
  }
}

function scanMaterializedDirectory(
  root: string,
  current: string,
  relativePath: string,
  dirs: string[],
  files: ProjectedSkillFile[],
): void {
  if (relativePath) dirs.push(relativePath);
  for (const name of fs.readdirSync(current).sort()) {
    scanMaterialized(root, path.join(current, name), path.posix.join(relativePath, name), dirs, files);
  }
}

function scanMaterialized(
  root: string,
  current: string,
  relativePath: string,
  dirs: string[],
  files: ProjectedSkillFile[],
): void {
  const stat = fs.lstatSync(current);
  if (stat.isSymbolicLink()) throw new Error(`Portable projection target is invalid: ${current}`);
  if (stat.isDirectory()) return scanMaterializedDirectory(root, current, relativePath, dirs, files);
  if (stat.isFile()) return pushFile(root, files, current, relativePath);
  throw new Error(`Portable projection target is invalid: ${current}`);
}

function actualTree(root: string): ProjectedSkillTree {
  const dirs: string[] = [];
  const files: ProjectedSkillFile[] = [];
  scanMaterialized(root, root, '', dirs, files);
  dirs.sort();
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { dirs, files, sha256: treeSha256(dirs, files) };
}

/** The parts of a tree a materialized copy can be compared on: the source's mtime/ctime/inode
 *  belong to the source, while a copy has its own. Path, byte length, mode and the directory set
 *  still catch a truncated, extra, missing or wrongly-permissioned projection. */
function materializedShape(tree: ProjectedSkillTree): string {
  return JSON.stringify({
    dirs: tree.dirs,
    files: tree.files.map(({ path, size, mode }) => ({ path, size, mode })),
  });
}

export function validateProjectedSkillTree(targetRoot: string, expected: ProjectedSkillTree): void {
  const stat = fs.lstatSync(targetRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Portable projection target is invalid: ${targetRoot}`);
  const actual = actualTree(targetRoot);
  if (materializedShape(actual) !== materializedShape(expected)) {
    throw new Error(`Portable projection skill tree mismatch: ${targetRoot}`);
  }
}
