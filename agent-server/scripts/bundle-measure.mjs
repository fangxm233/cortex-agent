// Process-cold (fresh Node process), filesystem-cache-warm timing; no privileged cache drops.
// Usage: node scripts/bundle-measure.mjs <current-package-root> <isolated-prefix> <bundle-tgz>
// Run with HOME and CORTEX_HOME pointing at credential-free /tmp directories.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import assert from 'node:assert/strict';

const [current, prefix, tarball] = process.argv.slice(2).map(value => path.resolve(value));
const bundled = path.join(prefix, 'lib/node_modules/@cortex-agent/server');
assert(process.env.HOME?.startsWith('/tmp/') && process.env.CORTEX_HOME?.startsWith('/tmp/'));
const env = { PATH: process.env.PATH, HOME: process.env.HOME, CORTEX_HOME: process.env.CORTEX_HOME, CORTEX_TELEMETRY: '0' };
function du(file) {
  if (!fs.existsSync(file)) return 0;
  const result = spawnSync('du', ['-sk', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return Number(result.stdout.split(/\s/)[0]) * 1024;
}
function breakdown(root) {
  const result = { total: du(root) };
  for (const part of ['dist', 'web', 'defaults', 'vendor', 'node_modules']) result[part] = du(path.join(root, part));
  for (const dep of ['agent-browser', 'sharp', '@img', '@silvia-odwyer']) result[dep] = du(path.join(root, 'node_modules', dep));
  return result;
}
function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? jsFiles(file) : /\.(m?js)$/.test(file) ? [file] : [];
  });
}
const js = [...jsFiles(path.join(bundled, 'dist')), ...jsFiles(path.join(bundled, 'vendor'))];
const source = Buffer.concat(js.map(file => fs.readFileSync(file)));
const timing = {};
// Alternate installations to reduce the effect of changing host load; include nonzero --version
// results explicitly, because the baseline's top-level CLI does not implement that flag.
for (const args of [['--version'], ['--help'], ['daemon', '--version']]) {
  const samples = { current: [], bundled: [] }, exitCodes = {};
  for (let i = 0; i < 9; i++) {
    for (const [label, root] of i % 2 ? [['bundled', bundled], ['current', current]] : [['current', current], ['bundled', bundled]]) {
      const start = performance.now();
      const result = spawnSync(process.execPath, [path.join(root, 'dist/entry/cortex-cli.js'), ...args], { env, encoding: 'utf8', timeout: 30000 });
      samples[label].push(Math.round((performance.now() - start) * 10) / 10);
      assert(!result.error, String(result.error)); exitCodes[label] = result.status;
    }
  }
  timing[args.join(' ')] = Object.fromEntries(Object.entries(samples).map(([label, values]) => [label, {
    exitCode: exitCodes[label], medianMs: [...values].sort((a, b) => a - b)[4], samplesMs: values,
  }]));
}
const browser = path.join(bundled, 'node_modules/agent-browser');
const binaries = fs.readdirSync(path.join(browser, 'bin')).filter(name => !name.startsWith('.') && name !== 'agent-browser.js')
  .map(name => ({ name, bytes: fs.statSync(path.join(browser, 'bin', name)).size }));
console.log(JSON.stringify({ node: process.version, units: 'bytes (disk allocation via du -sk); milliseconds',
  current: breakdown(current), bundled: breakdown(bundled), tarballBytes: fs.statSync(tarball).size,
  javascript: { files: js.length, bytes: source.length, concatenatedGzipBytes: gzipSync(source).length },
  browser: { binaries, totalBinaryBytes: binaries.reduce((sum, bin) => sum + bin.bytes, 0) }, timing,
}, null, 2));
