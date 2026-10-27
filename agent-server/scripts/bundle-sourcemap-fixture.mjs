import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const isolatedEnv = { ...process.env, CORTEX_HOME: '/tmp/cortex-bundled-rebuild/home',
  HOME: '/tmp/cortex-bundled-rebuild/os-home', npm_config_cache: '/tmp/cortex-bundled-rebuild/npm-cache' };
const scripts = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export function put(root, file, text) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
  return target;
}

export function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env: isolatedEnv, encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

function packageFixture(root, name, files) {
  const dir = path.join(root, 'node_modules', name);
  put(dir, 'package.json', JSON.stringify({ name, version: '1.0.0', type: 'module', main: 'dist/index.js' }));
  put(dir, 'LICENSE', 'Fixture license\n');
  put(dir, 'dist/index.js', 'export {};\n');
  for (const [file, text] of Object.entries(files)) put(dir, file, text);
  return dir;
}

function serverFixture(root) {
  put(root, 'package.json', JSON.stringify({ name: 'cortex-local-map-fixture', version: '1.0.0', type: 'module',
    main: 'dist/entry/app.js', bin: { cortex: 'dist/entry/app.js' }, dependencies: { 'agent-browser': '0.0.0' },
    optionalDependencies: { sharp: '0.0.0' } }));
  for (const file of ['entry/cli', 'entry/daemon', 'entry/production-app-bootstrap', 'tui/index',
    'domain/mcp/bundled-server', 'agent-adapter/claude/remote-mcp-proxy', 'domain/auth/cc-auth-cli']) {
    put(root, `dist/${file}.js`, 'export { sharedFail } from ' + JSON.stringify('../'.repeat(file.split('/').length - 1) + 'core/shared.js') + ';\n');
  }
  put(root, 'dist/entry/app.js', '#!/usr/bin/env node\n'
    + 'import { sharedFail } from "../core/shared.js";\n'
    + 'import { gatewayFail } from "../domain/costs/gateway-manager.js";\n'
    + 'import { wasmFail } from "@earendil-works/pi-coding-agent/dist/utils/image-resize.js";\n'
    + 'const actions = { shared: sharedFail, gateway: gatewayFail, wasm: wasmFail,\n'
    + '  entry() { throw new Error("entry fixture"); } };\n'
    + 'actions[process.argv[2]]();\n');
  put(root, 'dist/core/shared.js', 'export function sharedFail() {\n  const marker = "shared fixture";\n  throw new Error(marker);\n}\n');
  put(root, 'dist/domain/costs/gateway-manager.js', 'import path from "node:path";\n'
    + 'export function gatewayFail() {\n  const location = path.dirname(require.resolve(\'aistatus\')); throw new Error(location);\n}\n');
  put(root, 'dist/core/pi-sdk.js', 'const PI_SDK_PACKAGE = "unused", PI_MODEL_RESOLVER = "resolver.js";\n'
    + 'export async function resolve(entryUrl) {\n  const entry = entryUrl ?? import.meta.resolve(PI_SDK_PACKAGE);\n'
    + '  return await import(new URL(PI_MODEL_RESOLVER, entry).href);\n}\n');
  put(root, 'defaults/fixture.txt', 'default\n');
  put(root, 'dist/client-bundle/client.js', 'export {};\n');
  put(root, 'dist/client-bundle/client.js.map', '{"fixture":true}\n');
}

function piFixture(root) {
  return packageFixture(root, '@earendil-works/pi-coding-agent', {
    'dist/utils/image-resize.js': 'import { createRequire } from "node:module";\n'
      + 'export function wasmFail() {\n  const wasm = createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm"); throw new Error(wasm);\n}\n',
    'dist/utils/image-resize-worker.js': 'export {};\n',
    'dist/core/extensions/loader.js': 'export {};\n',
    'dist/core/model-resolver.js': 'export const fixture = true;\n',
    'dist/extensions/codemode/execute.js': 'export {};\n',
    'dist/extensions/codemode/worker.js': '// import.meta is not used by this worker.\nthrow new Error("worker fixture");\n',
    'README.md': 'fixture\n', 'CHANGELOG.md': 'fixture\n', 'docs/fixture.md': 'fixture\n',
    'examples/fixture.js': 'export {};\n', 'schemas/fixture.json': '{}\n',
    'dist/modes/interactive/theme/fixture.json': '{}\n', 'dist/modes/interactive/assets/fixture.txt': 'asset\n',
    'dist/core/export-html/fixture.html': '<html></html>\n',
  });
}

function aiFixture(root) {
  return packageFixture(root, '@earendil-works/pi-ai', {
    'dist/auth/oauth/load.js': 'export const loaded = importOAuthModule("./fixture.ts");\n',
    'dist/auth/oauth/fixture.js': '// OAuth fixture\nthrow new Error("oauth fixture");\n',
    'dist/api/bedrock-converse-stream.lazy.js': 'export const loaded = importNodeOnlyApi("./bedrock-converse-stream.ts");\n',
    'dist/api/bedrock-converse-stream.js': '// Bedrock fixture\nthrow new Error("bedrock fixture");\n',
  });
}

export function fixture(t) {
  fs.mkdirSync('/tmp/cortex-bundled-rebuild', { recursive: true });
  const cwd = fs.mkdtempSync('/tmp/cortex-bundled-rebuild/maps-');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const root = path.join(cwd, 'agent-server');
  serverFixture(root);
  const piRoot = piFixture(root);
  const aiRoot = aiFixture(root);
  packageFixture(root, 'aistatus', { 'dist/gateway-cli.js': 'export {};\n' });
  packageFixture(root, 'quickjs-wasi', { 'quickjs.wasm': 'fixture' });
  fs.symlinkSync(path.dirname(require.resolve('esbuild/package.json')), path.join(root, 'node_modules/esbuild'), 'dir');
  for (const name of ['bundle.mjs', 'bundle-compat.mjs', 'bundle-sourcemap.mjs', 'bundle-notices.mjs']) {
    put(root, `scripts/${name}`, fs.readFileSync(path.join(scripts, name), 'utf8'));
  }
  put(root, 'scripts/licenses/QuickJS-NG.txt', 'Fixture license\n');
  for (const name of ['bundle-prune-browser.mjs', 'postinstall-restart-trigger.mjs']) put(root, `scripts/${name}`, 'throw Error("must not run");\n');
  put(cwd, 'web/dist/index.html', '<html></html>\n');
  put(cwd, 'web/dist/index.js.map', '{}\n');
  for (const name of ['web', 'client']) put(cwd, `${name}/package.json`, '{}\n');
  for (const name of ['README.md', 'LICENSE']) put(cwd, name, 'fixture\n');
  return { cwd, root, piRoot, aiRoot };
}
