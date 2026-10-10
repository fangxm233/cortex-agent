import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { INSTALL_ROOT } from '@core/paths.js';

/** Ordered bytes are the existing client update/hello hash contract. */
export const CLIENT_BUNDLE_FILES = ['client.mjs', 'cortex-run-watcher.mjs'] as const;
export interface PackageClientBundle {
  version: string;
  hash: string;
  source: string;
  files: Array<{ name: string; data: string }>;
}

export function clientBundleHash(dir: string): string {
  const hash = createHash('sha256');
  for (const name of CLIENT_BUNDLE_FILES) hash.update(fs.readFileSync(path.join(dir, name)));
  return hash.digest('hex');
}

function readManifest(dir: string): Omit<PackageClientBundle, 'files'> {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const valid = typeof manifest?.version === 'string' && manifest.version.trim()
    && typeof manifest.hash === 'string' && /^[a-f0-9]{64}$/.test(manifest.hash)
    && typeof manifest.source === 'string' && /^(unknown|[a-f0-9]{40})$/.test(manifest.source);
  if (!valid) throw new Error('Invalid package-local client manifest; reinstall the server package');
  return { version: manifest.version, hash: manifest.hash, source: manifest.source };
}

/** No registry fallback: this payload belongs to the running server installation. */
export function loadPackageClientBundle(installRoot = INSTALL_ROOT): PackageClientBundle {
  const dir = path.join(installRoot, 'dist', 'client-bundle');
  const manifest = readManifest(dir);
  const hash = createHash('sha256');
  const files = CLIENT_BUNDLE_FILES.map(name => {
    const data = fs.readFileSync(path.join(dir, name));
    if (!data.length) throw new Error(`Empty package-local client file: ${name}`);
    hash.update(data);
    return { name, data: data.toString('base64') };
  });
  if (hash.digest('hex') !== manifest.hash) throw new Error('Package-local client hash mismatch; reinstall the server package');
  return { ...manifest, files };
}
