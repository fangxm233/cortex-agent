// input:  validated portable skill directories
// output: snapshots, copies, and exact validators
// pos:    Recursive portable skill projection helpers
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { containsPath } from './fs-helpers.js';

export interface ProjectedSkillFile {
  path: string;
  sha256: string;
  mode: number;
}

export interface ProjectedSkillTree {
  dirs: string[];
  files: ProjectedSkillFile[];
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

function pushFile(files: ProjectedSkillFile[], filePath: string, relativePath: string): void {
  const bytes = fs.readFileSync(filePath);
  const mode = fs.statSync(filePath).mode & 0o777;
  files.push({ path: relativePath, sha256: sha256(bytes), mode });
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
  if (target.isFile()) return pushFile(files, real, relativePath);
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
  if (stat.isFile()) return pushFile(files, logicalPath, relativePath);
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

function copyFile(packageRoot: string, source: string, target: string, mode: number): void {
  const resolved = safeRealpath(packageRoot, source);
  fs.writeFileSync(target, fs.readFileSync(resolved), { mode });
  fs.chmodSync(target, mode);
}

export function copyProjectedSkillTree(
  packageRoot: string,
  skillRoot: string,
  tree: ProjectedSkillTree,
  targetRoot: string,
): void {
  ensureDir(targetRoot);
  for (const dir of tree.dirs) ensureDir(path.join(targetRoot, dir));
  for (const file of tree.files) {
    ensureDir(path.dirname(path.join(targetRoot, file.path)));
    copyFile(packageRoot, path.join(skillRoot, file.path), path.join(targetRoot, file.path), file.mode);
  }
}

function scanMaterializedDirectory(
  current: string,
  relativePath: string,
  dirs: string[],
  files: ProjectedSkillFile[],
): void {
  if (relativePath) dirs.push(relativePath);
  for (const name of fs.readdirSync(current).sort()) {
    scanMaterialized(path.join(current, name), path.posix.join(relativePath, name), dirs, files);
  }
}

function scanMaterialized(
  current: string,
  relativePath: string,
  dirs: string[],
  files: ProjectedSkillFile[],
): void {
  const stat = fs.lstatSync(current);
  if (stat.isSymbolicLink()) throw new Error(`Claude projection target is invalid: ${current}`);
  if (stat.isDirectory()) return scanMaterializedDirectory(current, relativePath, dirs, files);
  if (stat.isFile()) return pushFile(files, current, relativePath);
  throw new Error(`Claude projection target is invalid: ${current}`);
}

function actualTree(root: string): ProjectedSkillTree {
  const dirs: string[] = [];
  const files: ProjectedSkillFile[] = [];
  scanMaterialized(root, '', dirs, files);
  dirs.sort();
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { dirs, files, sha256: treeSha256(dirs, files) };
}

export function validateProjectedSkillTree(targetRoot: string, expected: ProjectedSkillTree): void {
  const stat = fs.lstatSync(targetRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Claude projection target is invalid: ${targetRoot}`);
  const actual = actualTree(targetRoot);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Claude projection skill tree mismatch: ${targetRoot}`);
  }
}
