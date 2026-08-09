// input:  runtime directory path and error label
// output: private physical directory or fail-closed error
// pos:    Shared MCP runtime directory guard
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

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

export function ensurePrivateRuntimeDirectory(
  directory: string,
  label: string,
): void {
  const resolved = path.resolve(directory);
  assertNoSymlinkAncestors(resolved, label);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  assertNoSymlinkAncestors(resolved, label);
  if (fs.realpathSync(resolved) !== resolved) {
    throw new Error(`${label} is not a physical path: ${resolved}`);
  }
  fs.chmodSync(resolved, 0o700);
}
