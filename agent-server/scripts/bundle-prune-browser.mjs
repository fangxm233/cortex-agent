// Only shipped by the opt-in bundled package. Match agent-browser 0.39.1's launcher.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const binaries = new Set([
  'agent-browser-darwin-arm64', 'agent-browser-darwin-x64',
  'agent-browser-linux-arm64', 'agent-browser-linux-x64',
  'agent-browser-linux-musl-arm64', 'agent-browser-linux-musl-x64',
  'agent-browser-win32-x64.exe', 'agent-browser-win32-arm64.exe',
]);
function isMusl() {
  try {
    return execSync('ldd --version 2>&1 || true', { encoding: 'utf8' }).toLowerCase().includes('musl');
  } catch {
    return fs.existsSync('/lib/ld-musl-x86_64.so.1') || fs.existsSync('/lib/ld-musl-aarch64.so.1');
  }
}
export function hostBinary(platform, arch, musl, exists) {
  const os = { darwin: 'darwin', linux: musl ? 'linux-musl' : 'linux', win32: 'win32' }[platform];
  let cpu = { x64: 'x64', x86_64: 'x64', arm64: 'arm64', aarch64: 'arm64' }[arch];
  if (!os || !cpu) return null;
  if (os === 'win32' && cpu === 'arm64' && !exists('agent-browser-win32-arm64.exe')) cpu = 'x64';
  return `agent-browser-${os}-${cpu}${platform === 'win32' ? '.exe' : ''}`;
}
export function pruneBrowser(root, platform = process.platform, arch = process.arch, musl = platform === 'linux' && isMusl()) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (pkg.name !== 'agent-browser' || pkg.version !== '0.39.1' || pkg.bin?.['agent-browser'] !== './bin/agent-browser.js') return [];
  const bin = path.join(root, 'bin');
  const entries = fs.readdirSync(bin, { withFileTypes: true });
  if (entries.some(entry => !entry.isFile() || !binaries.has(entry.name) && !['agent-browser.js', '.gitkeep', '.install-method'].includes(entry.name))) return [];
  const names = new Set(entries.map(entry => entry.name));
  const host = hostBinary(platform, arch, musl, name => names.has(name));
  if (!names.has('agent-browser.js') || !names.has(host)) return [];
  const removed = entries.filter(entry => binaries.has(entry.name) && entry.name !== host).map(entry => entry.name);
  for (const name of removed) fs.unlinkSync(path.join(bin, name));
  return removed;
}
function main() {
  try {
    const require = createRequire(import.meta.url);
    const root = path.dirname(require.resolve('agent-browser/package.json'));
    const removed = pruneBrowser(root);
    if (removed.length) console.log(`Cortex: removed ${removed.length} unused agent-browser platform binaries`);
  } catch (error) {
    // Size optimization only: npm installation must not fail if pruning is unavailable.
    console.warn(`Cortex: skipped agent-browser pruning (${error.code ?? error.name})`);
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(pathToFileURL(process.argv[1]))) main();
