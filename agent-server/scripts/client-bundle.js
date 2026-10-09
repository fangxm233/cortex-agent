// Build-time packaging only. Direct invocation validates before pack/publish, including
// a fresh bundle comparison so a self-consistent but stale payload cannot ship.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = fileURLToPath(new URL('../', import.meta.url));
const bundleFiles = ['client.mjs', 'cortex-run-watcher.mjs'];

function sourceRevision(root) {
  const git = (...args) => execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  try {
    if (fs.realpathSync(git('rev-parse', '--show-toplevel')) !== fs.realpathSync(root)) return 'unknown';
    if (git('status', '--porcelain', '--untracked-files=normal')) return 'unknown';
    const sha = git('rev-parse', 'HEAD');
    return /^[a-f0-9]{40}$/.test(sha) ? sha : 'unknown';
  } catch {
    return 'unknown';
  }
}

function bundleHash(dir) {
  const hash = createHash('sha256');
  for (const file of bundleFiles) {
    const bytes = fs.readFileSync(path.join(dir, file));
    if (!bytes.length) throw new Error(`Empty client bundle file: ${file}`);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

function clientVersion(root) {
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'client/package.json'), 'utf8'));
  if (typeof version !== 'string' || !version) throw new Error('Invalid client package version');
  return version;
}

function buildClient(root) {
  const clientRoot = path.join(root, 'client');
  execFileSync(process.execPath, [path.join(clientRoot, 'scripts/bundle.js')], {
    cwd: clientRoot, stdio: 'inherit',
  });
  return path.join(clientRoot, 'dist');
}

function readManifest(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const valid = manifest && typeof manifest.version === 'string' && manifest.version.length > 0
    && typeof manifest.hash === 'string' && /^[a-f0-9]{64}$/.test(manifest.hash)
    && typeof manifest.source === 'string' && /^(unknown|[a-f0-9]{40})$/.test(manifest.source);
  if (!valid) throw new Error('Invalid client bundle manifest');
  return manifest;
}

export function stageClientBundle(serverRoot = pkgRoot) {
  const root = path.resolve(serverRoot, '..');
  const built = buildClient(root);
  const dest = path.join(serverRoot, 'dist/client-bundle');
  const manifest = {
    version: clientVersion(root), hash: bundleHash(built), source: sourceRevision(root),
  };
  fs.mkdirSync(dest, { recursive: true });
  for (const file of bundleFiles) fs.copyFileSync(path.join(built, file), path.join(dest, file));
  fs.writeFileSync(path.join(dest, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[client-bundle] staged ${manifest.version} (${manifest.hash})`);
}

export function validateClientBundle(serverRoot = pkgRoot) {
  const root = path.resolve(serverRoot, '..');
  const dest = path.join(serverRoot, 'dist/client-bundle');
  const manifest = readManifest(dest);
  if (bundleHash(dest) !== manifest.hash) throw new Error('Client bundle hash mismatch');
  if (manifest.version !== clientVersion(root) || manifest.source !== sourceRevision(root)) {
    throw new Error('Stale client bundle manifest; run the server build again');
  }
  if (bundleHash(buildClient(root)) !== manifest.hash) {
    throw new Error('Stale client bundle bytes; run the server build again');
  }
  console.log(`[client-bundle] validated ${manifest.version} (${manifest.hash})`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  validateClientBundle();
}
