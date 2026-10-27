// Offline, input-scoped supplement to esbuild's retained legal comments.
import fs from 'node:fs';
import path from 'node:path';

const legalName = /^(?:licen[cs]es?|notices?|copying)(?:$|[._-])/i;
const licenseName = /^(?:licen[cs]es?|copying)(?:$|[._-])/i;
const readmeName = /^readme(?:$|[._-])/i;
const workspace = name => name?.startsWith('@cortex-agent/');
const compare = (a, b) => a < b ? -1 : Number(a > b);
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
// Verbatim texts from spdx/license-list-data main/text/{MIT,Apache-2.0}.txt;
// QuickJS-NG from https://github.com/quickjs-ng/quickjs/blob/master/LICENSE.
const standardLicenses = new Set(['MIT', 'Apache-2.0']);
const licenseText = name => fs.readFileSync(new URL(`./licenses/${name}.txt`, import.meta.url), 'utf8');

function inferredName(root) {
  const parent = path.basename(path.dirname(root));
  return parent.startsWith('@') ? `${parent}/${path.basename(root)}` : path.basename(root);
}

function packageAt(root) {
  const real = fs.realpathSync(root);
  const manifest = path.join(real, 'package.json');
  const metadata = fs.existsSync(manifest) ? readJson(manifest) : {};
  return { root: real, metadata, name: metadata.name || inferredName(root), version: metadata.version || 'UNKNOWN' };
}

function inputPackage(cwd, input) {
  const absolute = path.resolve(cwd, input);
  const parts = absolute.split(path.sep);
  const index = parts.lastIndexOf('node_modules');
  if (index < 0 || !parts[index + 1]) return undefined;
  const end = index + (parts[index + 1].startsWith('@') ? 3 : 2);
  const root = parts.slice(0, end).join(path.sep);
  if (!fs.existsSync(root)) return undefined;
  // Use the npm boundary, not a nested dist/package.json declaring only module type.
  return packageAt(root);
}

function addPackage(records, item) {
  if (!item || workspace(item.name)) return;
  const key = JSON.stringify([item.name, item.version]);
  const roots = records.get(key) ?? new Map();
  roots.set(item.root, item);
  records.set(key, roots);
}

function dependencyNames(metadata) {
  return [...new Set([
    ...Object.keys(metadata.dependencies ?? {}),
    ...Object.keys(metadata.optionalDependencies ?? {}),
    ...Object.keys(metadata.peerDependencies ?? {}),
  ])].sort(compare);
}

function resolveDependency(root, name) {
  // Walk only Node's candidate paths; package exports may hide package.json.
  for (let dir = root; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (path.basename(dir) !== 'node_modules' && fs.existsSync(path.join(candidate, 'package.json'))) return packageAt(candidate);
    if (dir === path.dirname(dir)) return undefined;
  }
}

function requiredDependency(metadata, name) {
  return Object.hasOwn(metadata.dependencies ?? {}, name)
    && !Object.hasOwn(metadata.optionalDependencies ?? {}, name);
}

function enqueueDependencies(item, queue, warnings) {
  for (const name of dependencyNames(item.metadata)) {
    if (workspace(name)) continue;
    const dependency = resolveDependency(item.root, name);
    if (dependency) queue.push(dependency);
    else if (requiredDependency(item.metadata, name)) warnings.add(`WARNING: Unresolved production dependency: ${item.name} -> ${name}`);
  }
}

function addClosures(cwd, packageJsons, records, warnings) {
  const queue = packageJsons.map(file => {
    const manifest = path.resolve(cwd, file);
    // Explicit roots must exist and be valid, even if they have no dependencies.
    readJson(manifest);
    return packageAt(path.dirname(manifest));
  });
  const seen = new Set();
  const seeds = new Set(queue.map(item => item.root));
  for (let index = 0; index < queue.length; index++) {
    const item = queue[index];
    if (seen.has(item.root)) continue;
    seen.add(item.root);
    if (!seeds.has(item.root)) addPackage(records, item);
    enqueueDependencies(item, queue, warnings);
  }
}

function legalFiles(root, dir = root, all = false, seen = new Set(), files = []) {
  const real = fs.realpathSync(dir);
  if (!real.startsWith(root + path.sep) && real !== root) return files;
  if (seen.has(real)) return files;
  seen.add(real);
  for (const entry of fs.readdirSync(real, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || (!all && !legalName.test(entry.name))) continue;
    collectLegalEntry(root, path.join(real, entry.name), seen, files);
  }
  return files;
}

function collectLegalEntry(root, file, seen, files) {
  const real = fs.realpathSync(file);
  if (!real.startsWith(root + path.sep)) return;
  const stat = fs.statSync(real);
  if (stat.isDirectory()) legalFiles(root, real, true, seen, files);
  else if (stat.isFile()) files.push({ name: path.relative(root, file).split(path.sep).join('/'), text: fs.readFileSync(real, 'utf8') });
}

function headingLevel(lines, index) {
  const atx = /^(#{1,6})\s/.exec(lines[index]);
  if (atx) return atx[1].length;
  if (lines[index].trim() && /^\s*(?:=+|-+)\s*$/.test(lines[index + 1] ?? '')) return lines[index + 1].trim().startsWith('=') ? 1 : 2;
  return Infinity;
}

function readmeLicense(text) {
  const lines = text.split('\n');
  const sections = [];
  for (let index = 0; index < lines.length; index++) {
    const level = headingLevel(lines, index);
    if (!Number.isFinite(level) || !/licen[cs]e|copyright|copying/i.test(lines[index])) continue;
    let end = index + 1;
    while (end < lines.length && headingLevel(lines, end) > level) end++;
    sections.push(lines.slice(index, end).join('\n'));
    index = end - 1;
  }
  if (sections.length) return sections.join('\n');
  // Unstructured READMEs are kept whole rather than risk truncating legal terms.
  return /licen[cs]e|copyright|SPDX/i.test(text) ? text : '';
}

function readmeFiles(root) {
  return fs.readdirSync(root).filter(name => readmeName.test(name)).flatMap(name => {
    const file = path.join(root, name);
    const real = fs.realpathSync(file);
    if (!real.startsWith(root + path.sep) || !fs.statSync(real).isFile()) return [];
    const text = readmeLicense(fs.readFileSync(real, 'utf8'));
    return text ? [{ name: `${name} (license information)`, text }] : [];
  });
}

function declaredLicense(metadata) {
  const value = metadata.license ?? metadata.licenses;
  if (!value) return 'UNKNOWN';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function missingMetadata(metadata) {
  return ['name', 'version', 'license'].filter(key => {
    const value = key === 'license' ? metadata.license ?? metadata.licenses : metadata[key];
    return !value;
  });
}

function noticeFiles(items) {
  const unique = new Map();
  for (const item of items) {
    const files = legalFiles(item.root);
    const hasLicense = files.some(file => file.name.split('/').some(part => licenseName.test(part)));
    const supplemental = hasLicense ? [] : readmeFiles(item.root);
    for (const file of [...files, ...supplemental]) unique.set(JSON.stringify([file.name, file.text]), file);
  }
  return [...unique.values()].sort((a, b) => compare(a.name, b.name) || compare(a.text, b.text));
}

function fallbackNotice(items, licenses, standards) {
  const lines = ['WARNING: No LICENSE/LICENCE/COPYING file found; declared metadata and any README license information follow.'];
  for (const id of licenses.filter(id => standardLicenses.has(id))) {
    standards.add(id); lines.push(`The standard ${id} license text is included below; published attribution follows.`);
  }
  for (const item of items) {
    for (const key of ['author', 'contributors', 'copyright']) {
      if (item.metadata[key]) lines.push(`${key}: ${JSON.stringify(item.metadata[key])}`);
    }
  }
  return lines;
}

function renderPackage(roots, standards) {
  const items = [...roots.values()];
  const { name, version } = items[0];
  const licenses = [...new Set(items.map(item => declaredLicense(item.metadata)))].sort(compare);
  const missing = [...new Set(items.flatMap(item => missingMetadata(item.metadata)))];
  const files = noticeFiles(items);
  const lines = [`Package: ${name}@${version}`, ...licenses.map(license => `Declared license: ${license}`)];
  if (missing.length) lines.push(`Missing metadata: ${['name', 'version', 'license'].filter(key => missing.includes(key)).join(', ')}`);
  if (!files.some(file => file.name.split('/').some(part => licenseName.test(part)))) lines.push(...fallbackNotice(items, licenses, standards));
  for (const file of files) lines.push(`\n--- ${file.name} ---\n${file.text}`);
  return lines.join('\n');
}

/**
 * Synchronously return offline notices for metafile input paths (plus copied WASM)
 * and installed production closures of web/client manifests. Optional dependencies
 * and installed peers count; devDependencies and @cortex-agent workspaces do not.
 * Legal files are read at package roots and recursively inside legal directories,
 * never by scanning the whole node_modules tree. No files are written or changed.
 */
export function thirdPartyNotices({ cwd, inputFiles = [], packageJsons = [] }) {
  const records = new Map();
  const warnings = new Set();
  for (const input of inputFiles) addPackage(records, inputPackage(cwd, input));
  addClosures(cwd, packageJsons, records, warnings);
  const standards = new Set();
  const packages = [...records.values()].map(roots => renderPackage(roots, standards)).sort(compare);
  const texts = [...standards].sort(compare).map(id => `SPDX standard license text: ${id}\n\n${licenseText(id)}`);
  const hasQuickJS = [...records.values()].some(roots => [...roots.values()].some(item => item.name === 'quickjs-wasi'));
  if (hasQuickJS) texts.push(`QuickJS-NG embedded engine\nSource: https://github.com/quickjs-ng/quickjs/blob/master/LICENSE\n\n${licenseText('QuickJS-NG')}`);
  const header = 'THIRD-PARTY NOTICES\n\nSupplement to retained bundled legal comments. Standard license templates retain their placeholders; package attribution is listed above them where published.\n';
  return [header, ...[...warnings].sort(compare), ...packages, ...texts].join('\n\n' + '='.repeat(72) + '\n\n') + '\n';
}
