// Stage the published package after the workspace build. Source installs keep their normal layout.
// Never mutates dist/, package.json or node_modules; pack the printed stage for release.
// Optional --sourcemap links local JS maps; npm pack excludes maps in either mode.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { bundleCompatibility } from './bundle-compat.mjs';
import { thirdPartyNotices } from './bundle-notices.mjs';
import { prepareOutputs } from './bundle-sourcemap.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
// Refuse to reuse a stage: stale chunks must never accidentally mask a missing entry.
const args = process.argv.slice(2);
const sourcemap = args.includes('--sourcemap');
const stage = path.resolve(args.filter(arg => arg !== '--sourcemap')[0] ?? path.join(root, '.bundle-package'));
if (fs.existsSync(stage)) throw new Error(`Stage already exists; choose a fresh directory: ${stage}`);
const piRoot = path.resolve(path.dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), '..');
const aiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-ai'))), '..');
const gatewayEntry = path.join(path.dirname(require.resolve('aistatus')), 'gateway-cli.js');
const posix = value => value.split(path.sep).join('/');
const write = (rel, content) => {
  const dest = path.join(stage, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content);
};
const copy = (src, rel, filter) => {
  fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true });
  fs.cpSync(src, path.join(stage, rel), { recursive: true, filter });
};
// Keep path-addressed entry points explicit and review this list when spawn sites change.
const runtimeEntries = [...new Set([
  pkg.main, ...Object.values(pkg.bin),
  'dist/entry/cli.js', 'dist/entry/daemon.js', 'dist/entry/production-app-bootstrap.js',
  'dist/tui/index.js', 'dist/domain/mcp/bundled-server.js',
  'dist/agent-adapter/claude/remote-mcp-proxy.js',
  // Publicly inspectable seams for the installed-package smoke test (not extra npm bins).
  'dist/core/pi-sdk.js', 'dist/domain/auth/cc-auth-cli.js',
])];
const entries = Object.fromEntries(runtimeEntries.map(rel => [rel.slice(0, -3), path.join(root, rel)]));
entries['vendor/aistatus/gateway-cli'] = gatewayEntry;
entries['vendor/pi/dist/utils/image-resize-worker'] = path.join(piRoot, 'dist/utils/image-resize-worker.js');
entries['vendor/pi/dist/utils/image-resize'] = path.join(piRoot, 'dist/utils/image-resize.js');
entries['vendor/pi/dist/core/extensions/loader'] = path.join(piRoot, 'dist/core/extensions/loader.js');
entries['vendor/pi-ai/oauth-load'] = path.join(aiRoot, 'dist/auth/oauth/load.js');
entries['vendor/pi-ai/bedrock'] = path.join(aiRoot, 'dist/api/bedrock-converse-stream.lazy.js');
entries['vendor/pi/dist/extensions/codemode/execute'] = path.join(piRoot, 'dist/extensions/codemode/execute.js');

const external = ['sharp', 'agent-browser', '@silvia-odwyer/photon-node', 'readline/promises', 'bufferutil', 'utf-8-validate'];
const compatibility = bundleCompatibility({ root, piRoot, aiRoot }, { sourcemap });
const options = {
  absWorkingDir: root, bundle: true, platform: 'node', target: 'node22.19', format: 'esm',
  minify: true, legalComments: 'eof', external, write: false, metafile: true,
  sourcemap: sourcemap ? 'linked' : false,
  define: { PI_BUNDLED_NODE: 'true', 'process.env.NODE_ENV': '"production"', 'process.env.DEV': '"false"' }, plugins: [compatibility], logLevel: 'info',
};
function outputBanner(file) {
  const rootRelative = posix(path.relative(path.dirname(file), stage)) + '/';
  // CJS dependencies can require Node builtins. Keep Node's require available in ESM chunks.
  return `import { createRequire as __cortexCreateRequire } from 'node:module';\nconst require = __cortexCreateRequire(import.meta.url);\nconst __cortexPackageRoot = new URL(${JSON.stringify(rootRelative)}, import.meta.url);\n`;
}
function saveOutputs(result, addBanner = true) {
  const outputs = prepareOutputs(result.outputFiles, addBanner ? outputBanner : undefined);
  for (const output of outputs) write(path.relative(stage, output.path), output.text);
}
// Fail early if the build or frontend is missing, before making a stage.
for (const file of Object.values(entries)) if (!fs.existsSync(file)) throw new Error(`Missing build input: ${file}`);
if (!fs.existsSync(path.join(root, '../web/dist/index.html'))) throw new Error('Build web first: pnpm --filter @cortex-agent/web bundle');
const result = await build({ ...options, entryPoints: entries, outdir: stage, splitting: true, chunkNames: 'dist/chunks/[name]-[hash]' });
saveOutputs(result);
// Pi reads this worker into a data: URL: it must be self-contained, without relative imports.
const worker = await build({ ...options, entryPoints: [path.join(piRoot, 'dist/extensions/codemode/worker.js')], outfile: path.join(stage, 'vendor/pi/dist/codemode-worker.js') });
if (worker.outputFiles.some(file => file.path.endsWith('.js') && file.text.includes('import.meta'))) throw new Error('Codemode worker must be data-URL safe');
saveOutputs(worker, false);
copy(require.resolve('quickjs-wasi/quickjs.wasm'), 'vendor/quickjs.wasm');
copy(path.join(root, 'defaults'), 'defaults');
// Match release-server's hidden-map policy without deleting the worktree's debugging assets.
copy(path.join(root, '../web/dist'), 'web/dist', file => !file.endsWith('.map'));
copy(path.join(root, 'dist/client-bundle'), 'dist/client-bundle');
for (const rel of ['package.json', 'README.md', 'CHANGELOG.md', 'docs', 'examples', 'schemas', 'dist/modes/interactive/theme', 'dist/modes/interactive/assets', 'dist/core/export-html']) {
  copy(path.join(piRoot, rel), `vendor/pi/${rel}`, file => !file.endsWith('.map') && !file.endsWith('.d.ts'));
}
copy(path.join(root, '../README.md'), 'README.md');
copy(path.join(root, '../LICENSE'), 'LICENSE');
for (const rel of ['dist/build-info.json']) {
  if (fs.existsSync(path.join(root, rel))) copy(path.join(root, rel), rel);
}
for (const script of ['bundle-prune-browser.mjs', 'postinstall-restart-trigger.mjs']) copy(path.join(root, 'scripts', script), `scripts/${script}`);
write('THIRD_PARTY_NOTICES.txt', thirdPartyNotices({
  cwd: root,
  inputFiles: [...Object.keys(result.metafile.inputs), ...Object.keys(worker.metafile.inputs), require.resolve('quickjs-wasi/quickjs.wasm')],
  packageJsons: [path.join(root, '../web/package.json'), path.join(root, '../client/package.json')],
}));
const manifest = { ...pkg,
  cortexBundle: true,
  files: ['dist/', 'defaults/', 'web/dist/', 'vendor/', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.txt',
    'scripts/bundle-prune-browser.mjs', 'scripts/postinstall-restart-trigger.mjs', '!**/*.map'],
  scripts: { postinstall: 'node scripts/bundle-prune-browser.mjs && node scripts/postinstall-restart-trigger.mjs' }, dependencies: { 'agent-browser': pkg.dependencies['agent-browser'], '@silvia-odwyer/photon-node': '0.3.4' },
  optionalDependencies: { sharp: pkg.optionalDependencies.sharp },
};
delete manifest.devDependencies;
delete manifest.private;
write('package.json', JSON.stringify(manifest, null, 2) + '\n');
for (const rel of Object.values(pkg.bin)) fs.chmodSync(path.join(stage, rel), 0o755);
// Keep audit data outside the published file allowlist.
write('bundle-meta.json', JSON.stringify({ runtimeEntries, external, ...result.metafile }, null, 2));
console.log(`Staged release package: ${stage}\nPack: cd ${stage} && npm pack --ignore-scripts`);
