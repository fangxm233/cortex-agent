// input:  npm pack lifecycle, clean package fixture, native builder
// output: packed 0755 executable and manifest digest contract
// pos:    Verifies the published supervisor artifact from a clean tree
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'vitest';

const SERVER_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REPO_ROOT = path.dirname(SERVER_ROOT);
const roots: string[] = [];

function excluded(relative: string): boolean {
  return relative === 'dist'
    || relative === 'node_modules'
    || relative === 'web/dist'
    || relative === 'native/cortex-supervisor/build'
    || relative === 'native/cortex-supervisor/dist'
    || relative.endsWith('.tgz');
}

function copyCleanPackage(root: string): string {
  const server = path.join(root, 'agent-server');
  fs.cpSync(SERVER_ROOT, server, {
    recursive: true,
    filter: source => !excluded(path.relative(SERVER_ROOT, source)),
  });
  fs.copyFileSync(path.join(REPO_ROOT, 'README.md'), path.join(root, 'README.md'));
  fs.mkdirSync(path.join(root, 'web/dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'web/dist/index.html'), '<!doctype html>\n');
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(root, 'node_modules'));
  fs.symlinkSync(path.join(SERVER_ROOT, 'node_modules'), path.join(server, 'node_modules'));
  return server;
}

function pack(server: string, destination: string): string {
  const previousUmask = process.umask(0o077);
  try {
    const result = spawnSync('npm', ['pack', '--pack-destination', destination], {
      cwd: server,
      encoding: 'utf8',
      timeout: 300_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const tarballs = fs.readdirSync(destination).filter(file => file.endsWith('.tgz'));
    assert.equal(tarballs.length, 1, `expected one tarball, got ${tarballs.join(', ')}`);
    return path.join(destination, tarballs[0]);
  } finally {
    process.umask(previousUmask);
  }
}

function extract(tarball: string, destination: string): string {
  fs.mkdirSync(destination);
  const result = spawnSync('tar', ['-xzf', tarball, '-C', destination], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return path.join(destination, 'package/native/cortex-supervisor/dist');
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('npm pack builds and co-packs a 0755 supervisor under a restrictive umask', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-package-supervisor-'));
  roots.push(root);
  const server = copyCleanPackage(root);
  const supervisorDist = path.join(server, 'native/cortex-supervisor/dist');
  assert.equal(fs.existsSync(supervisorDist), false, 'fixture must not contain a stale build');

  const packedDist = extract(pack(server, root), path.join(root, 'extracted'));
  const binary = path.join(packedDist, 'cortex-supervisor');
  const manifest = JSON.parse(fs.readFileSync(path.join(packedDist, 'build-manifest.json'), 'utf8'));
  const digest = createHash('sha256').update(fs.readFileSync(binary)).digest('hex');

  assert.equal(fs.statSync(binary).mode & 0o777, 0o755);
  assert.equal(digest, manifest.binary_sha256);
}, 300_000);
