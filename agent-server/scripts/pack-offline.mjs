// input:  package manifest, the workspace node_modules it resolves against, npm pack arguments
// output: an npm tarball carrying its whole runtime closure, installable without a registry
// pos:    Offline artifact packer for the benchmark harness
// >>> If I am updated, update my header and folder CORTEX.md <<<
//
// The published package is thin: it declares dependencies and lets the installer fetch them. The
// benchmark installs Cortex into containers with no registry, so it needs the opposite artifact --
// one that carries all 300-odd packages. That requirement belongs to the benchmark, not to every
// `npm i @cortex-agent/server`, so it lives here instead of in the manifest's pack lifecycle.
//
// `bundleDependencies` is written into the manifest *before* npm is invoked rather than from a
// prepack hook. npm reads the manifest twice around prepack -- on npm 10 the pack file list honours
// a hook-injected field while npm's own "bundled files" notice does not -- and the release path
// runs a different npm major than this host. Mutating first leaves npm nothing to disagree about.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, '..');
const manifestPath = path.join(packageRoot, 'package.json');
const stageScript = path.join(scriptDir, 'stage-bundled-dependencies.mjs');

/** Every direct runtime dependency, which is exactly what must survive into the tarball. Derived
 *  rather than listed, because a hand-maintained copy drifts the moment a dependency is added. */
function bundledNames(manifest) {
  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ].sort();
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: packageRoot, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
  }
}

function packOffline(passthroughArgs) {
  // The exact bytes, so the restore is a byte-for-byte revert and never reformats the manifest.
  const original = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(original);
  if (manifest.bundleDependencies !== undefined) {
    throw new Error('package.json already declares bundleDependencies; the thin-package assumption this script is built on no longer holds');
  }
  manifest.bundleDependencies = bundledNames(manifest);

  try {
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    run(process.execPath, [stageScript]);
    run('npm', ['pack', '--offline', ...passthroughArgs]);
  } finally {
    fs.writeFileSync(manifestPath, original);
    run(process.execPath, [stageScript, '--cleanup']);
  }
}

packOffline(process.argv.slice(2));
