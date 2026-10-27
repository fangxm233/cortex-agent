import fs from 'node:fs';
import path from 'node:path';
import { SourceRewriter } from './bundle-sourcemap.mjs';
const posix = value => value.split(path.sep).join('/');
function replaceOnce(source, before, after, file) {
  if (source.text.split(before).length !== 2) throw new Error(`Bundle compatibility check changed: ${file}: ${before}`);
  return source.replace(before, after);
}
function modelResolver(source, file) {
  source = replaceOnce(source, 'await import(new URL(PI_MODEL_RESOLVER, entry).href)',
    '(entryUrl ? await import(new URL(PI_MODEL_RESOLVER, entry).href) : await import("cortex:pi-model-resolver"))', file);
  return replaceOnce(source, 'entryUrl ?? import.meta.resolve(PI_SDK_PACKAGE)', 'entryUrl ?? "file:///unused-bundled-entry.js"', file);
}
function gatewayLocation(source, file) {
  source = replaceOnce(source, "path.dirname(require.resolve('aistatus'))", 'fileURLToPath(new URL("vendor/aistatus/", __cortexPackageRoot))', file);
  return source.prepend('import { fileURLToPath } from "node:url";\n');
}
function logicalUrl(source, relative) {
  return source.replaceAll('import.meta.url', `new URL(${JSON.stringify(posix(relative))}, __cortexPackageRoot).href`);
}
function serverSource(source, file, root) {
  if (file === path.join(root, 'dist/core/pi-sdk.js')) source = modelResolver(source, file);
  if (file === path.join(root, 'dist/domain/costs/gateway-manager.js')) source = gatewayLocation(source, file);
  source = source.replaceAll("createRequire(import.meta.url)('@larksuiteoapi/node-sdk')", "require('@larksuiteoapi/node-sdk')");
  return logicalUrl(source, path.relative(root, file));
}
function nodeOnlyImports(source, file, aiRoot) {
  if (file === path.join(aiRoot, 'dist/auth/oauth/load.js')) {
    return source.replace(/importOAuthModule\("\.\/([\w-]+)\.ts"\)/g, (_match, name) => `import("./${name}.js")`);
  }
  if (file === path.join(aiRoot, 'dist/api/bedrock-converse-stream.lazy.js')) {
    return replaceOnce(source, 'importNodeOnlyApi("./bedrock-converse-stream.ts")', 'import("./bedrock-converse-stream.js")', file);
  }
  return source;
}
function wasmLocation(source) {
  if (!source.text.includes('.resolve("quickjs-wasi/quickjs.wasm")')) return source;
  const needsImport = !source.text.includes('import { fileURLToPath }');
  source = source.replace(/createRequire\([^;\n]+?\)\.resolve\("quickjs-wasi\/quickjs.wasm"\)/g,
    'fileURLToPath(new URL("vendor/quickjs.wasm", __cortexPackageRoot))');
  return needsImport ? source.prepend('import { fileURLToPath } from "node:url";\n') : source;
}
function transformSource(source, file, { root, piRoot, aiRoot }) {
  if (file.endsWith('/ink/build/reconciler.js')) source = replaceOnce(source, "process.env['DEV'] === 'true'", 'false', file);
  if (file.startsWith(path.join(root, 'dist/'))) source = serverSource(source, file, root);
  if (file.startsWith(piRoot + path.sep)) source = logicalUrl(source, 'vendor/pi/' + posix(path.relative(piRoot, file)));
  return wasmLocation(nodeOnlyImports(source, file, aiRoot));
}
export function bundleCompatibility(roots, { sourcemap = false } = {}) {
  return {
    name: 'cortex-runtime-layout',
    setup(builder) {
      builder.onResolve({ filter: /^cortex:pi-model-resolver$/ }, () => ({ path: path.join(roots.piRoot, 'dist/core/model-resolver.js') }));
      builder.onLoad({ filter: /\.[cm]?js$/ }, ({ path: file }) => {
        const original = fs.readFileSync(file, 'utf8');
        let source = new SourceRewriter(original, sourcemap);
        if (file.endsWith('.js')) source = transformSource(source, file, roots);
        // In local-map mode always return JS contents, preventing esbuild from
        // following upstream map directives into TS or unavailable vendor sources.
        if (!sourcemap && source.text === original) return undefined;
        return { contents: source.contents(file), loader: 'js', resolveDir: path.dirname(file) };
      });
    },
  };
}
