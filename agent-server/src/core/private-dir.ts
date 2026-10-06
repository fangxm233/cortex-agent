import fs from 'node:fs';
import path from 'node:path';

function assertNoSymlinkAncestors(directory: string, label: string): void {
  let current = path.resolve(directory);
  while (true) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`${label} has a symlink ancestor: ${current}`);
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

/**
 * Create `directory` (and missing parents) as a private 0700 directory, refusing any path that
 * reaches it through a symlink. Pass a path from {@link physicalUnder} when the directory lives
 * below an operator-chosen root such as CORTEX_HOME: a symlink AT or ABOVE that root is ordinary
 * setup, and rejecting it would fail every private write on such an install.
 */
export function ensurePrivateDirectory(directory: string, label: string): void {
  const resolved = path.resolve(directory);
  assertNoSymlinkAncestors(resolved, label);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  assertNoSymlinkAncestors(resolved, label);
  if (fs.realpathSync(resolved) !== resolved) {
    throw new Error(`${label} is not a physical path: ${resolved}`);
  }
  fs.chmodSync(resolved, 0o700);
}

/**
 * `target` re-anchored on the real path of the trusted `root` it lies under, so whatever symlinks
 * lead to the root stop mattering while any symlink below it still does. A target outside `root`,
 * or a root that does not exist, comes back unchanged and is checked all the way up.
 */
export function physicalUnder(root: string, target: string): string {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  const rel = path.relative(base, resolved);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return resolved;
  try {
    return path.join(fs.realpathSync(base), rel);
  } catch {
    return resolved;
  }
}
