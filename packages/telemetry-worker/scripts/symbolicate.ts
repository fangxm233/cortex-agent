/**
 * Maps a minified Web UI stack (from a crash sample) back to source using the
 * `web-sourcemaps-<version>.tgz` asset of that version's GitHub release.
 *   pnpm -C packages/telemetry-worker symbolicate -- --version <version> [options]   (see --help)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, relative, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { SourceMapConsumer, type RawSourceMap } from 'source-map';
import { CliError, printJson, readInput, runMain } from './cli.js';

const DEFAULT_REPO = 'fangxm233/cortex-agent';
const VERSION = /^[0-9A-Za-z.+-]{1,40}$/;
/** `name.js:line:column`, optionally behind a URL or path prefix. */
const FRAME_LOCATION = /(?:[^\s()@]*\/)?([A-Za-z0-9_$.-]+\.m?js):(\d+):(\d+)/;

const HELP = `Usage: pnpm -C packages/telemetry-worker symbolicate -- --version <version> [options]

Reads a minified Web UI stack and maps every frame of a bundled asset back to its source file.
The maps come from the release asset web-sourcemaps-<version>.tgz (paths relative to web/dist),
cached under the system temp directory. Desktop-bundled frontends ship without maps.

Options:
  --version <v>        Cortex version that produced the stack (required unless --maps-dir)
  --stack-file <p|->   File holding the stack; - reads stdin (default: -)
  --maps-dir <dir>     Use an extracted maps directory instead of downloading
  --repo <owner/name>  GitHub repository (default: ${DEFAULT_REPO})
  --tag <tag>          Release tag (default: server-v<version>)
  --text               Print only the mapped stack text
  -h, --help           This help

Examples:
  pbpaste | pnpm -C packages/telemetry-worker symbolicate -- --version 2026.10.24
  pnpm -C packages/telemetry-worker symbolicate -- --version 2026.10.24 --stack-file crash.txt --text
  pnpm -C packages/telemetry-worker symbolicate -- --maps-dir ../../web/dist --stack-file crash.txt`;

export interface MappedFrame {
  line: number;
  generated: string;
  source: string | null;
  originalLine: number | null;
  originalColumn: number | null;
  name: string | null;
}

interface LoadedMap {
  consumer: SourceMapConsumer;
  /** Directory of the map relative to web/dist, for resolving its `sources`. */
  baseDir: string;
}

function walkMaps(dir: string, found = new Map<string, string>()): Map<string, string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkMaps(path, found);
    else if (entry.name.endsWith('.map')) found.set(entry.name.slice(0, -'.map'.length), path);
  }
  return found;
}

/** Loads the map of every asset the stack mentions; callers destroy the consumers. */
export async function loadMaps(mapsDir: string, assetNames: Set<string>): Promise<Map<string, LoadedMap>> {
  const available = walkMaps(mapsDir);
  const loaded = new Map<string, LoadedMap>();
  for (const name of assetNames) {
    const path = available.get(name);
    if (!path) continue;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as RawSourceMap;
    const baseDir = posix.dirname(relative(mapsDir, path).split(sep).join('/'));
    loaded.set(name, { consumer: await new SourceMapConsumer(raw), baseDir });
  }
  return loaded;
}

function sourcePath(map: LoadedMap, source: string): string {
  const root = (map.consumer as SourceMapConsumer & { sourceRoot?: string }).sourceRoot ?? '';
  return source.startsWith('webpack:') || /^[a-z]+:\/\//.test(source)
    ? source
    : posix.normalize(posix.join('web/dist', map.baseDir, root, source));
}

function mapFrame(line: string, index: number, maps: Map<string, LoadedMap>): MappedFrame | null {
  const match = FRAME_LOCATION.exec(line);
  const map = match ? maps.get(match[1]) : undefined;
  if (!match || !map) return null;
  const position = map.consumer.originalPositionFor({ line: Number(match[2]), column: Number(match[3]) - 1 });
  return {
    line: index,
    generated: match[0],
    source: position.source ? sourcePath(map, position.source) : null,
    originalLine: position.line,
    originalColumn: position.column === null ? null : position.column + 1,
    name: position.name,
  };
}

function rewriteLine(line: string, frame: MappedFrame | null): string {
  if (!frame?.source) return line;
  const location = `${frame.source}:${frame.originalLine}:${frame.originalColumn}`;
  return `${line.replace(frame.generated, location)}${frame.name ? `  [${frame.name}]` : ''}`;
}

export function assetNames(stack: string): Set<string> {
  const names = stack.split('\n').map(line => FRAME_LOCATION.exec(line)?.[1]);
  return new Set(names.filter((name): name is string => Boolean(name)));
}

export async function symbolicate(stack: string, mapsDir: string): Promise<{ stack: string; frames: MappedFrame[] }> {
  const maps = await loadMaps(mapsDir, assetNames(stack));
  try {
    const lines = stack.split('\n');
    const frames = lines.map((line, index) => mapFrame(line, index, maps));
    return {
      stack: lines.map((line, index) => rewriteLine(line, frames[index])).join('\n'),
      frames: frames.filter((frame): frame is MappedFrame => frame !== null),
    };
  } finally {
    for (const map of maps.values()) map.consumer.destroy();
  }
}

/** Downloads and extracts the release's map archive once; later runs reuse the cache. */
async function releaseMaps(version: string, repo: string, tag: string): Promise<string> {
  const dir = join(tmpdir(), 'cortex-web-sourcemaps', version);
  if (existsSync(join(dir, '.complete'))) return dir;
  const asset = `web-sourcemaps-${version}.tgz`;
  const url = `https://github.com/${repo}/releases/download/${tag}/${asset}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new CliError(`Download failed (${response.status}): ${url}`, 'Check --version / --tag; builds before source maps were published have none.');
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const archive = join(dir, asset);
  writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  const untar = spawnSync('tar', ['-xzf', archive, '-C', dir], { encoding: 'utf8' });
  if (untar.status !== 0) throw new Error(`tar failed: ${untar.stderr}`);
  writeFileSync(join(dir, '.complete'), url);
  return dir;
}

function parseOptions(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      version: { type: 'string' }, 'stack-file': { type: 'string', default: '-' },
      'maps-dir': { type: 'string' }, repo: { type: 'string', default: DEFAULT_REPO },
      tag: { type: 'string' }, text: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  }).values;
}

async function resolveMapsDir(options: ReturnType<typeof parseOptions>): Promise<string> {
  if (options['maps-dir']) return options['maps-dir'];
  const version = options.version ?? '';
  if (!VERSION.test(version)) throw new CliError(`Invalid --version: '${version}'.`, 'Use the envelope version of the crash, e.g. --version 2026.10.24');
  return releaseMaps(version, options.repo, options.tag ?? `server-v${version}`);
}

async function main(argv: string[]): Promise<void> {
  const options = parseOptions(argv);
  if (options.help) return void process.stdout.write(`${HELP}\n`);
  const mapsDir = await resolveMapsDir(options);
  const result = await symbolicate(readInput(options['stack-file']), mapsDir);
  if (options.text) return void process.stdout.write(`${result.stack}\n`);
  printJson({ ok: true, version: options.version ?? null, mapsDir, mapped: result.frames.filter(f => f.source).length, ...result });
}

runMain(import.meta.url, main);
