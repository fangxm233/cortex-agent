import * as fs from 'fs';
import * as path from 'path';

/** Marks files this module owns; remove and refresh never touch a file without it. */
export const SHIM_MARKER = 'cortex-managed-shim';
const HEADER = `${SHIM_MARKER}: written by \`cortex path install\`, refreshed when the daemon starts.`;

export interface ShimTarget {
  node: string;
  home: string;
  bins: Array<{ name: string; entry: string }>;
}

export interface RenderedShim {
  file: string;
  content: string;
}

export function shimDir(home: string): string {
  return path.join(home, 'runtime', 'bin');
}

/** The package's `bin` map as absolute entry paths. */
export function packageBins(installRoot: string): ShimTarget['bins'] {
  const manifest = JSON.parse(fs.readFileSync(path.join(installRoot, 'package.json'), 'utf8'));
  return Object.entries<string>(manifest.bin ?? {}).map(([name, rel]) => ({ name, entry: path.join(installRoot, rel) }));
}

const shQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

function posixShim(node: string, entry: string, home: string, nodeDirOnPath: string): string {
  return [
    '#!/bin/sh',
    `# ${HEADER}`,
    `if [ -z "\${CORTEX_HOME:-}" ]; then CORTEX_HOME=${shQuote(home)}; fi`,
    'export CORTEX_HOME',
    `PATH=${shQuote(nodeDirOnPath)}:"$PATH"; export PATH`,
    `exec ${shQuote(node)} ${shQuote(entry)} "$@"`,
    '',
  ].join('\n');
}

function cmdShim(node: string, entry: string, home: string): string {
  const esc = (value: string) => value.replace(/%/g, '%%');
  return [
    '@echo off',
    `rem ${HEADER}`,
    'setlocal',
    `if not defined CORTEX_HOME set "CORTEX_HOME=${esc(home)}"`,
    `set "PATH=${esc(path.win32.dirname(node))};%PATH%"`,
    `"${esc(node)}" "${esc(entry)}" %*`,
    '',
  ].join('\r\n');
}

/** `C:\x\y` → `C:/x/y` (native programs) and `/c/x/y` (Git Bash PATH entries). */
const forward = (winPath: string) => winPath.replace(/\\/g, '/');
const msys = (winPath: string) => forward(winPath).replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);

export function renderShims(target: ShimTarget, platform: NodeJS.Platform = process.platform): RenderedShim[] {
  if (platform !== 'win32') {
    const nodeDir = path.posix.dirname(target.node);
    return target.bins.map(({ name, entry }) => ({ file: name, content: posixShim(target.node, entry, target.home, nodeDir) }));
  }
  return target.bins.flatMap(({ name, entry }) => [
    { file: `${name}.cmd`, content: cmdShim(target.node, entry, target.home) },
    {
      file: name,
      content: posixShim(forward(target.node), forward(entry), forward(target.home), msys(path.win32.dirname(target.node))),
    },
  ]);
}

function readIfExists(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

export function listManagedShims(dir: string): string[] {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((name) => readIfExists(path.join(dir, name))?.includes(SHIM_MARKER)).sort();
}

/** Shims whose on-disk content differs from `rendered` (missing ones included). */
export function staleShims(dir: string, rendered: RenderedShim[]): string[] {
  return rendered.filter((shim) => readIfExists(path.join(dir, shim.file)) !== shim.content).map((shim) => shim.file);
}

/** Write changed shims and drop managed ones no longer rendered; returns files written. */
export function writeShims(dir: string, rendered: RenderedShim[]): string[] {
  fs.mkdirSync(dir, { recursive: true });
  const written = staleShims(dir, rendered);
  for (const file of written) {
    const shim = rendered.find((candidate) => candidate.file === file)!;
    fs.writeFileSync(path.join(dir, file), shim.content, { mode: 0o755 });
    fs.chmodSync(path.join(dir, file), 0o755);
  }
  const keep = new Set(rendered.map((shim) => shim.file));
  for (const name of listManagedShims(dir)) if (!keep.has(name)) fs.unlinkSync(path.join(dir, name));
  return written;
}

/** Delete managed shims, then the directory if nothing else is in it; returns files removed. */
export function removeShims(dir: string): string[] {
  const removed = listManagedShims(dir);
  for (const name of removed) fs.unlinkSync(path.join(dir, name));
  try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* already gone */ }
  return removed;
}

/** Re-point existing shims at the running node and entry (e.g. after a bundled Node upgrade). */
export function refreshShims(dir: string, rendered: RenderedShim[]): string[] {
  if (listManagedShims(dir).length === 0) return [];
  return writeShims(dir, rendered);
}
