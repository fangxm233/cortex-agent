#!/usr/bin/env node
//
// Feature-level cycle check.
//
// dependency-cruiser's `no-circular` catches cycles between MODULES. It cannot see the
// thing that actually rots a feature tree: two feature directories that import each
// other, with no single module cycle anywhere in the pair. `features/workbench` and
// `features/thread` reaching into each other is a design problem even when every
// individual file has a clean acyclic path.
//
// So: collapse the module graph to one node per `src/features/<name>/`, keep runtime
// edges only, and fail on any bidirectional pair that is not in the allow-list.
//
// The allow-list (scripts/feature-cycles-allowlist.json) is a ratchet. A pair that is
// listed but no longer real is also an error — that is what keeps the list shrinking
// instead of quietly outliving the cycles it was written for. Delete the stale entry.
//
// Usage:
//   node scripts/check-feature-cycles.mjs                 # runs depcruise itself
//   node scripts/check-feature-cycles.mjs graph.json      # reads a prior --output-type json
//
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST = path.join(WEB_DIR, 'scripts', 'feature-cycles-allowlist.json');
const FEATURE_RE = /^src\/features\/([^/]+)\//;
const IS_TEST = /\.test\.tsx?$/;

/** Locate the depcruise CLI without going through npx (offline-safe). The package's `exports`
 *  map hides `package.json` from `require.resolve`, so walk the resolver's search paths instead. */
function depcruiseBin() {
  const require = createRequire(import.meta.url);
  for (const dir of require.resolve.paths('dependency-cruiser') ?? []) {
    const pkgPath = path.join(dir, 'dependency-cruiser', 'package.json');
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.depcruise;
    return bin ? path.join(path.dirname(pkgPath), bin) : null;
  }
  return null;
}

function loadGraph() {
  const fromFile = process.argv[2];
  if (fromFile) return JSON.parse(readFileSync(path.resolve(fromFile), 'utf8'));

  const bin = depcruiseBin();
  const [cmd, args] = bin
    ? [process.execPath, [bin, 'src', '--output-type', 'json']]
    : ['npx', ['depcruise', 'src', '--output-type', 'json']];
  // `npx` is a .cmd shim on Windows, which only a shell can start.
  const shell = !bin && process.platform === 'win32';
  const run = spawnSync(cmd, args, { cwd: WEB_DIR, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, shell });
  // depcruise exits non-zero when rules are violated; the graph on stdout is still valid.
  if (!run.stdout) {
    console.error('check-feature-cycles: could not run depcruise');
    if (run.stderr) console.error(run.stderr.trim());
    process.exit(2);
  }
  return JSON.parse(run.stdout);
}

/** src/features/<name>/… → <name>; anything else → null. */
function featureOf(source) {
  if (!source || IS_TEST.test(source)) return null;
  const m = FEATURE_RE.exec(source);
  return m ? m[1] : null;
}

const graph = loadGraph();
const edges = new Set(); // "from→to"

for (const mod of graph.modules ?? []) {
  const from = featureOf(mod.source);
  if (!from) continue;
  for (const dep of mod.dependencies ?? []) {
    if ((dep.dependencyTypes ?? []).includes('type-only')) continue;
    const to = featureOf(dep.resolved);
    if (!to || to === from) continue;
    edges.add(`${from}→${to}`);
  }
}

const found = new Set();
for (const edge of edges) {
  const [a, b] = edge.split('→');
  if (edges.has(`${b}→${a}`)) found.add([a, b].sort().join('<->'));
}

let allowed;
try {
  allowed = new Set(JSON.parse(readFileSync(ALLOWLIST, 'utf8')));
} catch (err) {
  console.error(`check-feature-cycles: cannot read ${path.relative(WEB_DIR, ALLOWLIST)} — ${err.message}`);
  process.exit(2);
}

const added = [...found].filter((p) => !allowed.has(p)).sort();
const stale = [...allowed].filter((p) => !found.has(p)).sort();

if (added.length) {
  console.error(`\n✖ ${added.length} new bidirectional feature dependency/dependencies:\n`);
  for (const pair of added) console.error(`    ${pair}`);
  console.error(
    '\n  Two features importing each other are one feature, or one of them is missing a'
    + '\n  seam. Extract the shared part (a *-vm module, a context, a type) instead of'
    + '\n  adding these to scripts/feature-cycles-allowlist.json.\n',
  );
}

if (stale.length) {
  console.error(`\n✖ ${stale.length} stale allow-list entry/entries — these cycles are gone:\n`);
  for (const pair of stale) console.error(`    ${pair}`);
  console.error(
    `\n  Remove them from ${path.relative(WEB_DIR, ALLOWLIST)}. The allow-list may only`
    + '\n  ever shrink; leaving dead entries in it re-opens the door you just closed.\n',
  );
}

if (added.length || stale.length) process.exit(1);

console.log(`✔ feature cycles: ${found.size} known pair(s), 0 new. (${edges.size} inter-feature edges)`);
