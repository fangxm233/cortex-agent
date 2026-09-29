import * as fs from 'fs';
import * as path from 'path';

/**
 * Resolve a file to upload (relative paths against the process cwd) and check it is a readable
 * regular file. Shared by the platform adapters and the MCP upload tools, so it stays free of any
 * SDK import.
 */
export function resolveReadableFilePath(filePath: string): { resolved: string; size: number } {
  const resolved = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`Not a file: ${resolved}`);
  return { resolved, size: stat.size };
}
