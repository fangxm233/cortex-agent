// input:  node:fs, node:path
// output: listing and containment helpers
// pos:    Symlink-safe guards for plugin catalog I/O
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import fs from 'node:fs';
import path from 'node:path';

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function containsPath(root: string, target: string): boolean {
  const base = path.resolve(root);
  const candidate = path.resolve(target);
  return candidate === base || candidate.startsWith(base + path.sep);
}

function pathExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function existingAnchor(target: string): { base: string; tail: string[] } | null {
  const tail: string[] = [];
  let base = path.resolve(target);
  while (!pathExists(base)) {
    const parent = path.dirname(base);
    if (parent === base) return null;
    tail.unshift(path.basename(base));
    base = parent;
  }
  return { base, tail };
}

function joinTail(base: string, tail: string[]): string {
  return tail.reduce((current, part) => path.join(current, part), base);
}

function realPath(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

function physicalPath(target: string): string | null {
  const anchor = existingAnchor(target);
  const base = anchor ? realPath(anchor.base) : null;
  return base && anchor ? joinTail(base, anchor.tail) : null;
}

function relativeTail(root: string, target: string): string[] | null {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel === '') return [];
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return null;
  }
  return rel.split(path.sep).filter(Boolean);
}

function containedStep(base: string, current: string, part: string): string | null {
  const next = path.join(current, part);
  if (!pathExists(next)) return next;
  const resolved = realPath(next);
  return resolved && containsPath(base, resolved) ? resolved : null;
}

function finishContainedPath(base: string, target: string): string | null {
  return containsPath(base, target) ? target : null;
}

export function resolveContainedAbsolutePath(
  root: string,
  absolutePath: string,
): string | null {
  const base = physicalPath(root);
  const tail = relativeTail(root, absolutePath);
  if (!base || !tail) return null;
  let current = base;
  for (const part of tail) {
    current = containedStep(base, current, part);
    if (!current) return null;
  }
  return finishContainedPath(base, current);
}

export function resolveContainedRelativePath(
  root: string,
  relativePath: string,
): string | null {
  return resolveContainedAbsolutePath(root, path.resolve(root, relativePath));
}

export function isRegularFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function isDirectoryPath(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

export function listImmediateChildNames(directory: string): string[] {
  if (!pathExists(directory)) return [];
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
}

export function lstatExists(filePath: string): boolean {
  return pathExists(filePath);
}
