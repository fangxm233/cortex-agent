#!/usr/bin/env node
// Stage the official runtime archives a desktop build ships in desktop/src-tauri/bundled-runtime/.
//
//   node desktop/scripts/fetch-bundled-runtime.mjs [--target <rust-triple>]
//
// Every target gets the official Node.js archive; Windows also gets PortableGit, unpacked with 7-Zip
// and repacked as a plain .7z the app can extract in-process. Downloads are checked against the
// SHA-256 pins below and cached (CORTEX_RUNTIME_CACHE, default ~/.cache/cortex-bundled-runtime).
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const NODE_VERSION = '24.21.0';
// https://nodejs.org/dist/v24.21.0/SHASUMS256.txt
const NODE = {
  'aarch64-apple-darwin': ['darwin-arm64', 'tar.gz', 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057'],
  'x86_64-apple-darwin': ['darwin-x64', 'tar.gz', '1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097'],
  'x86_64-unknown-linux-gnu': ['linux-x64', 'tar.gz', '6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff'],
  'aarch64-unknown-linux-gnu': ['linux-arm64', 'tar.gz', '724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5'],
  'x86_64-pc-windows-msvc': ['win-x64', 'zip', '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'],
};
const GIT = {
  version: '2.56.0.2',
  tag: 'v2.56.0.windows.2',
  url: 'https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/PortableGit-2.56.0.2-64-bit.7z.exe',
  sha256: '075e158ef8e1f0ab80b347e245405d3eca735c2dc88fd8e032e137d0ca61f61b',
};

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../src-tauri/bundled-runtime');
const cache = process.env.CORTEX_RUNTIME_CACHE || join(homedir(), '.cache', 'cortex-bundled-runtime');

function hostTarget() {
  const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
  const os = { darwin: 'apple-darwin', linux: 'unknown-linux-gnu', win32: 'pc-windows-msvc' }[process.platform];
  return arch && os ? `${arch}-${os}` : `${process.arch}-${process.platform}`;
}

function parseTarget(argv) {
  const at = argv.indexOf('--target');
  if (at === -1) return hostTarget();
  if (!argv[at + 1]) throw new Error('--target needs a Rust target triple');
  return argv[at + 1] === 'universal-apple-darwin' ? null : argv[at + 1];
}

async function sha256(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/** Cached download, verified against its pin before and after fetching. */
async function fetchPinned(url, name, expected) {
  await mkdir(cache, { recursive: true });
  const file = join(cache, name);
  if (existsSync(file) && (await sha256(file)) === expected) return file;
  console.log(`downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);
  const partial = `${file}.partial`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  const actual = await sha256(partial);
  if (actual !== expected) {
    await rm(partial, { force: true });
    throw new Error(`${name}: SHA-256 ${actual} does not match the pin ${expected}`);
  }
  await rename(partial, file);
  return file;
}

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: ['ignore', 'inherit', 'inherit'], ...options });
}

function sevenZip() {
  for (const candidate of ['7z', '7za', 'C:\\Program Files\\7-Zip\\7z.exe']) {
    try {
      execFileSync(candidate, ['i'], { stdio: 'ignore' });
      return candidate;
    } catch { /* try the next name */ }
  }
  throw new Error('7-Zip (7z) is required to repack PortableGit');
}

/** PortableGit ships as a 7-Zip SFX; repack it as a plain .7z under a versioned root folder. */
async function repackedGit() {
  const root = `git-${GIT.version}`;
  const archive = join(cache, `${root}-x64.7z`);
  const license = join(cache, `${root}-LICENSE.txt`);
  if (existsSync(archive) && existsSync(license)) return { archive, license, root };
  const sfx = await fetchPinned(GIT.url, `PortableGit-${GIT.version}-64-bit.7z.exe`, GIT.sha256);
  const zip = sevenZip();
  const work = join(tmpdir(), `cortex-portablegit-${process.pid}`);
  await rm(work, { recursive: true, force: true });
  try {
    run(zip, ['x', sfx, `-o${join(work, root)}`, '-y', '-bso0', '-bsp0']);
    await copyFile(join(work, root, 'LICENSE.txt'), license);
    const partial = `${archive}.partial.7z`;
    await rm(partial, { force: true });
    run(zip, ['a', '-t7z', '-mx=9', '-md=128m', '-bso0', '-bsp0', partial, root], { cwd: work });
    await rename(partial, archive);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return { archive, license, root };
}

/** Pull one file out of the official Node archive. */
async function extractMember(archive, member, destination) {
  const dir = join(tmpdir(), `cortex-node-license-${process.pid}`);
  await mkdir(dir, { recursive: true });
  try {
    if (archive.endsWith('.zip')) run(sevenZip(), ['x', archive, `-o${dir}`, member, '-y', '-bso0', '-bsp0']);
    else run('tar', ['-xf', archive, '-C', dir, member]);
    await copyFile(join(dir, member), destination);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function clearOutput() {
  await mkdir(out, { recursive: true });
  for (const entry of await readdir(out)) {
    if (entry !== '.gitkeep') await rm(join(out, entry), { recursive: true, force: true });
  }
}

async function main() {
  const target = parseTarget(process.argv.slice(2));
  if (!target) throw new Error('universal macOS builds are not supported; build aarch64 and x86_64 separately');
  const pin = NODE[target];
  if (!pin) throw new Error(`no bundled runtime for ${target}`);
  const [platform, extension, digest] = pin;
  const nodeRoot = `node-v${NODE_VERSION}-${platform}`;
  const nodeArchive = `${nodeRoot}.${extension}`;
  const node = await fetchPinned(`https://nodejs.org/dist/v${NODE_VERSION}/${nodeArchive}`, nodeArchive, digest);
  const git = target.includes('windows') ? await repackedGit() : null;

  await clearOutput();
  await mkdir(join(out, 'licenses'), { recursive: true });
  await copyFile(node, join(out, nodeArchive));
  await extractMember(node, `${nodeRoot}/LICENSE`, join(out, 'licenses', 'node-LICENSE.txt'));
  const notices = [
    `Node.js v${NODE_VERSION} (${nodeArchive})`,
    '  License: MIT, with bundled third-party licenses (node-LICENSE.txt)',
    `  Source: https://github.com/nodejs/node/tree/v${NODE_VERSION}`,
  ];
  const manifest = { target, node: { version: NODE_VERSION, archive: nodeArchive, root: nodeRoot } };
  if (git) {
    const name = `${git.root}-x64.7z`;
    await copyFile(git.archive, join(out, name));
    await copyFile(git.license, join(out, 'licenses', 'git-for-windows-LICENSE.txt'));
    manifest.git = { version: GIT.version, archive: name, root: git.root };
    notices.push(
      '',
      `Git for Windows ${GIT.tag} (PortableGit, repacked as ${name})`,
      '  License: GNU GPL version 2 and the component licenses in git-for-windows-LICENSE.txt',
      `  Original package: ${GIT.url}`,
      `  Source: https://github.com/git-for-windows/git/tree/${GIT.tag}`,
      '  Component sources: https://github.com/git-for-windows/build-extra and https://github.com/msys2',
    );
  }
  await writeFile(join(out, 'licenses', 'README.txt'), `${notices.join('\n')}\n`);
  await writeFile(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`bundled runtime for ${target} staged in ${out}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
