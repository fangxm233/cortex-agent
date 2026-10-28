// Opt-in prototype. Input is an installed code-split bundle; output never overwrites it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { zstdCompressSync, constants } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { verifyTarget } from './sea-target.mjs';

const { values } = parseArgs({ options: {
  package: { type: 'string' }, output: { type: 'string' }, executable: { type: 'string' },
  platform: { type: 'string', default: process.platform }, arch: { type: 'string', default: process.arch },
  'code-cache': { type: 'boolean', default: false }, strip: { type: 'boolean', default: true }, help: { type: 'boolean' },
}, allowNegative: true });
if (values.help || !values.package || !values.output) {
  console.log('Usage: node scripts/sea-build.mjs --package <installed-bundle> --output <new-directory> [--executable <node>] [--platform linux|win32] [--arch x64] [--code-cache] [--no-strip]\nExample: node scripts/sea-build.mjs --package /tmp/bundle --output /tmp/sea');
  process.exit(values.help ? 0 : 1);
}
const source = path.resolve(values.package), out = path.resolve(values.output);
if (fs.existsSync(out)) throw new Error(`Output exists; choose a fresh directory: ${out}`);
const scripts = fileURLToPath(new URL('.', import.meta.url));
let executable = path.resolve(values.executable || process.execPath);
const target = verifyTarget(executable, values.platform, values.arch, values['code-cache']);
const hostBrowser = `agent-browser-${values.platform}-${values.arch}${values.platform === 'win32' ? '.exe' : ''}`;
function include(name) {
  // Pi's docs stay readable for the agent; their screenshots are only for human readers.
  if (name.startsWith('vendor/pi/docs/images/')) return false;
  if (name.startsWith('node_modules/agent-browser/bin/agent-browser-')) return name.endsWith('/' + hostBrowser);
  if (/^node_modules\/(?:sharp|@img|\.bin)(?:\/|$)/.test(name)) return false;
  return !['bundle-meta.json', 'package-lock.json'].includes(name) && !name.endsWith('.map');
}
function records(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const name = prefix + entry.name, file = path.join(directory, entry.name);
    if (!include(name) || entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) return records(file, name + '/');
    return [[name, fs.statSync(file).mode & 0o777, fs.readFileSync(file)]];
  });
}
const files = records(source);
for (const file of ['sea-runtime.cjs', 'sea-preload.cjs']) {
  files.push([file, 0o644, fs.readFileSync(path.join(scripts, file))]);
}
const header = Buffer.from(JSON.stringify(files.map(([name, mode, data]) => [name, mode, data.length])));
const headerLength = Buffer.alloc(4);
headerLength.writeUInt32LE(header.length);
const payload = zstdCompressSync(Buffer.concat([headerLength, header, ...files.map(file => file[2])]),
  { params: { [constants.ZSTD_c_compressionLevel]: 19 } });
const id = `${JSON.parse(fs.readFileSync(path.join(source, 'package.json'))).version}-${createHash('sha256').update(payload).digest('hex').slice(0, 12)}`;
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'payload.zst'), payload);
// Linux Node ships ~32 MiB of symbol tables and DWARF; injection and execution use only loaded sections.
const strip = values.strip && target.platform === 'linux';
if (strip) {
  const stripped = path.join(out, 'node-stripped');
  try { execFileSync('strip', ['--strip-all', '-o', stripped, executable]); }
  catch (error) { throw new Error(`strip failed (install binutils or pass --no-strip): ${error.message}`); }
  executable = stripped;
}
await build({ entryPoints: [path.join(scripts, 'sea-launcher.cjs')], outfile: path.join(out, 'launcher.cjs'),
  bundle: true, platform: 'node', target: 'node26', format: 'cjs', define: { SEA_BUILD_ID: JSON.stringify(id) } });
const output = path.join(out, values.platform === 'win32' ? 'cortex.exe' : 'cortex');
const config = { main: path.join(out, 'launcher.cjs'), output, executable, disableExperimentalSEAWarning: true,
  useCodeCache: values['code-cache'], assets: { payload: path.join(out, 'payload.zst') } };
fs.writeFileSync(path.join(out, 'sea-config.json'), JSON.stringify(config, null, 2));
execFileSync(process.execPath, ['--build-sea', path.join(out, 'sea-config.json')], { stdio: 'inherit' });
if (strip) fs.rmSync(executable);
fs.chmodSync(output, 0o755);
const manifest = { id, node: target.version, platform: target.platform, arch: target.arch,
  codeCache: values['code-cache'], stripped: strip, compression: 'zstd-19', files: files.length, extractedBytes: files.reduce((sum, file) => sum + file[2].length, 0),
  payloadBytes: payload.length, binaryBytes: fs.statSync(output).size };
fs.writeFileSync(path.join(out, 'build.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ ok: true, executable: output, ...manifest }, null, 2));
