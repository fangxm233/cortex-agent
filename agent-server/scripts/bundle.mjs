// Opt-in prototype: build normally, then `pnpm bundle:package` and npm pack the printed stage.
// Never mutates dist/, package.json, node_modules, or the normal publishing lifecycle.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
// Refuse to reuse a stage: stale chunks must never accidentally mask a missing entry.
const stage = path.resolve(process.argv[2] ?? path.join(root, '.bundle-package'));
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
const copy = (src, rel) => {
  fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true });
  fs.cpSync(src, path.join(stage, rel), { recursive: true });
};
function replaceOnce(source, before, after, file) {
  if (source.split(before).length !== 2) throw new Error(`Bundle compatibility check changed: ${file}: ${before}`);
  return source.replace(before, after);
}

// Keep path-addressed entry points explicit and review this list when spawn sites change.
const runtimeEntries = [...new Set([
  pkg.main, ...Object.values(pkg.bin),
  'dist/entry/cli.js', 'dist/entry/daemon.js', 'dist/entry/production-app-bootstrap.js',
  'dist/tui/index.js', 'dist/domain/mcp/bundled-server.js',
  'dist/agent-adapter/claude/remote-mcp-proxy.js',
  // Publicly inspectable seams for the installed-package smoke test (not extra npm bins).
  'dist/core/pi-sdk.js',
])];
const entries = Object.fromEntries(runtimeEntries.map(rel => [rel.slice(0, -3), path.join(root, rel)]));
entries['vendor/aistatus/gateway-cli'] = gatewayEntry;
entries['vendor/pi/dist/utils/image-resize-worker'] = path.join(piRoot, 'dist/utils/image-resize-worker.js');
entries['vendor/pi/dist/core/extensions/loader'] = path.join(piRoot, 'dist/core/extensions/loader.js');
entries['vendor/pi-ai/oauth-load'] = path.join(aiRoot, 'dist/auth/oauth/load.js');
entries['vendor/pi-ai/bedrock'] = path.join(aiRoot, 'dist/api/bedrock-converse-stream.lazy.js');
entries['vendor/pi/dist/extensions/codemode/execute'] = path.join(piRoot, 'dist/extensions/codemode/execute.js');

const external = ['sharp', 'agent-browser', '@silvia-odwyer/photon-node', 'readline/promises', 'bufferutil', 'utf-8-validate'];
const compatibility = {
  name: 'cortex-runtime-layout',
  setup(builder) {
    builder.onResolve({ filter: /^cortex:pi-model-resolver$/ }, () => ({ path: path.join(piRoot, 'dist/core/model-resolver.js') }));
    builder.onLoad({ filter: /\.js$/ }, async ({ path: file }) => {
      let source = fs.readFileSync(file, 'utf8');
      const original = source;
      if (file.endsWith('/ink/build/reconciler.js')) {
        source = replaceOnce(source, "process.env['DEV'] === 'true'", 'false', file);
      }
      if (file === path.join(root, 'dist/core/pi-sdk.js')) {
        source = replaceOnce(source,
          'await import(new URL(PI_MODEL_RESOLVER, entry).href)',
          '(entryUrl ? await import(new URL(PI_MODEL_RESOLVER, entry).href) : await import("cortex:pi-model-resolver"))', file);
        source = replaceOnce(source, 'entryUrl ?? import.meta.resolve(PI_SDK_PACKAGE)', 'entryUrl ?? "file:///unused-bundled-entry.js"', file);
      }
      if (file === path.join(root, 'dist/domain/costs/gateway-manager.js')) {
        source = replaceOnce(source, "path.dirname(require.resolve('aistatus'))", 'fileURLToPath(new URL("vendor/aistatus/", __cortexPackageRoot))', file);
        source = 'import { fileURLToPath } from "node:url";\n' + source;
      }
      if (file.startsWith(path.join(root, 'dist/'))) {
        // An esbuild chunk's URL is NOT the URL of the original module. Preserve logical URLs
        // for main-module guards, sibling spawns, defaults, version and web asset lookups.
        // Turn opaque createRequire calls into statically discoverable, still-lazy CJS loads.
        source = source.replaceAll("createRequire(import.meta.url)('@larksuiteoapi/node-sdk')", "require('@larksuiteoapi/node-sdk')");
        source = source.replaceAll('import.meta.url', `new URL(${JSON.stringify(posix(path.relative(root, file)))}, __cortexPackageRoot).href`);
      }
      if (file.startsWith(piRoot + path.sep)) {
        source = source.replaceAll('import.meta.url', `new URL(${JSON.stringify('vendor/pi/' + posix(path.relative(piRoot, file)))}, __cortexPackageRoot).href`);
      }
      // pi-ai deliberately hides these Node-only imports from browser bundlers. This is Node.
      if (file === path.join(aiRoot, 'dist/auth/oauth/load.js')) {
        source = source.replace(/importOAuthModule\("\.\/([\w-]+)\.ts"\)/g, 'import("./$1.js")');
      }
      if (file === path.join(aiRoot, 'dist/api/bedrock-converse-stream.lazy.js')) {
        source = replaceOnce(source, 'importNodeOnlyApi("./bedrock-converse-stream.ts")', 'import("./bedrock-converse-stream.js")', file);
      }
      if (source.includes('.resolve("quickjs-wasi/quickjs.wasm")')) {
        source = source.replace(/createRequire\([^;\n]+?\)\.resolve\("quickjs-wasi\/quickjs.wasm"\)/g,
          'fileURLToPath(new URL("vendor/quickjs.wasm", __cortexPackageRoot))');
        if (!original.includes('import { fileURLToPath }')) source = 'import { fileURLToPath } from "node:url";\n' + source;
      }
      return source === original ? undefined : { contents: source, loader: 'js', resolveDir: path.dirname(file) };
    });
  },
};
const options = {
  absWorkingDir: root, bundle: true, platform: 'node', target: 'node22.19', format: 'esm',
  minify: true, legalComments: 'eof', external, write: false, metafile: true,
  define: { PI_BUNDLED_NODE: 'true', 'process.env.NODE_ENV': '"production"', 'process.env.DEV': '"false"' }, plugins: [compatibility], logLevel: 'info',
};
function saveOutputs(result) {
  for (const output of result.outputFiles) {
    const rel = path.relative(stage, output.path);
    let text = output.text;
    if (rel.endsWith('.js')) {
      const rootRelative = posix(path.relative(path.dirname(output.path), stage)) + '/';
      const banner = `import { createRequire as __cortexCreateRequire } from 'node:module';\nconst require = __cortexCreateRequire(import.meta.url);\nconst __cortexPackageRoot = new URL(${JSON.stringify(rootRelative)}, import.meta.url);\n`;
      // CJS dependencies can require Node builtins. Keep Node's require available in ESM chunks.
      const shebang = text.startsWith('#!') ? text.slice(0, text.indexOf('\n') + 1) : '';
      text = shebang + banner + text.slice(shebang.length);
    }
    write(rel, text);
  }
}
// Fail early if the build or frontend is missing, before making a stage.
for (const file of Object.values(entries)) if (!fs.existsSync(file)) throw new Error(`Missing build input: ${file}`);
if (!fs.existsSync(path.join(root, '../web/dist/index.html'))) throw new Error('Build web first: pnpm --filter @cortex-agent/web bundle');
const result = await build({ ...options, entryPoints: entries, outdir: stage, splitting: true, chunkNames: 'dist/chunks/[name]-[hash]' });
saveOutputs(result);
// Pi reads this worker into a data: URL: it must be self-contained, without relative imports.
const worker = await build({ ...options, entryPoints: [path.join(piRoot, 'dist/extensions/codemode/worker.js')], outfile: path.join(stage, 'vendor/pi/dist/codemode-worker.js') });
saveOutputs(worker);
copy(require.resolve('quickjs-wasi/quickjs.wasm'), 'vendor/quickjs.wasm');
copy(path.join(root, 'defaults'), 'defaults');
copy(path.join(root, '../web/dist'), 'web/dist');
copy(path.join(root, 'dist/client-bundle'), 'dist/client-bundle');
for (const rel of ['package.json', 'README.md', 'CHANGELOG.md', 'docs', 'dist/modes/interactive/theme', 'dist/modes/interactive/assets', 'dist/core/export-html']) {
  copy(path.join(piRoot, rel), `vendor/pi/${rel}`);
}
for (const rel of ['README.md', 'dist/build-info.json']) {
  if (fs.existsSync(path.join(root, rel))) copy(path.join(root, rel), rel);
}
const manifest = { ...pkg,
  private: true, // Prototype: cannot accidentally publish this stage.
  files: ['dist/', 'defaults/', 'web/dist/', 'vendor/', 'README.md'],
  scripts: {}, dependencies: { 'agent-browser': pkg.dependencies['agent-browser'], '@silvia-odwyer/photon-node': '0.3.4' },
  optionalDependencies: { sharp: pkg.optionalDependencies.sharp },
};
delete manifest.devDependencies;
write('package.json', JSON.stringify(manifest, null, 2) + '\n');
for (const rel of Object.values(pkg.bin)) fs.chmodSync(path.join(stage, rel), 0o755);
// Keep audit data outside the published file allowlist.
write('bundle-meta.json', JSON.stringify({ runtimeEntries, external, ...result.metafile }, null, 2));
console.log(`Staged prototype: ${stage}\nPack: cd ${stage} && npm pack --ignore-scripts`);
