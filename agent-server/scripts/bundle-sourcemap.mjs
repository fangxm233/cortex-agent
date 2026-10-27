// Local maps target prebundle JavaScript, never upstream TypeScript maps.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const upstreamMap = /[#@]\s*sourceMappingURL=/;

export function insertBanner(text, banner, map) {
  const offset = text.startsWith('#!') ? text.indexOf('\n') + 1 : 0;
  const result = { text: text.slice(0, offset) + banner + text.slice(offset), map };
  if (!map) return result;
  const lines = map.mappings.split(';');
  lines.splice(offset ? 1 : 0, 0, ...Array(banner.split('\n').length - 1).fill(''));
  result.map = { ...map, mappings: lines.join(';') };
  return result;
}

function relocateMap(file, text) {
  const map = JSON.parse(text);
  // Maps are restored from the temporary stage into a different install path.
  map.sources = map.sources.map(source => pathToFileURL(path.resolve(path.dirname(file), source)).href);
  return JSON.stringify(map) + '\n';
}

// esbuild's linked map and its JS must be updated together after banner insertion.
export function prepareOutputs(outputs, bannerFor = () => '') {
  const updated = new Map(outputs.map(output => [output.path,
    output.path.endsWith('.map') ? relocateMap(output.path, output.text) : output.text]));
  for (const output of outputs.filter(output => output.path.endsWith('.js'))) {
    const mapPath = output.path + '.map';
    const map = updated.has(mapPath) ? JSON.parse(updated.get(mapPath)) : undefined;
    const result = insertBanner(output.text, bannerFor(output.path), map);
    updated.set(output.path, result.text);
    if (result.map) updated.set(mapPath, JSON.stringify(result.map) + '\n');
  }
  return [...updated].map(([path, text]) => ({ path, text }));
}

function vlq(value) {
  let encoded = '';
  let remaining = value < 0 ? -value * 2 + 1 : value * 2;
  do {
    const digit = remaining % 32;
    remaining = Math.floor(remaining / 32);
    encoded += alphabet[digit + (remaining ? 32 : 0)];
  } while (remaining);
  return encoded;
}

function originalPosition(offset, original, state) {
  // Edits preserve source order; walk once instead of allocating a tuple per character.
  while (state.offset < offset) {
    if (original[state.offset] === '\n') { state.originalLine++; state.originalColumn = 0; }
    else state.originalColumn++;
    state.offset++;
  }
  return [state.originalLine, state.originalColumn];
}

function mappingSegment(offset, column, state, original) {
  const generated = vlq(column - state.generated);
  state.generated = column;
  if (offset < 0) return generated; // Synthetic imports have no original location.
  const [line, originalColumn] = originalPosition(offset, original, state);
  const segment = generated + 'A' + vlq(line - state.line) + vlq(originalColumn - state.column);
  state.line = line;
  state.column = originalColumn;
  return segment;
}

function mappingsFor(text, offsets, original) {
  const state = { generated: 0, line: 0, column: 0, offset: 0, originalLine: 0, originalColumn: 0 };
  let offset = 0;
  return text.split('\n').map(line => {
    state.generated = 0;
    const segments = Array.from({ length: line.length }, (_, column) =>
      mappingSegment(offsets[offset + column], column, state, original));
    offset += line.length + 1;
    return segments.join(',');
  }).join(';');
}

// Compatibility edits and upstream maps need an intermediate JS-to-JS map.
// Character-level mappings keep unchanged suffix columns exact after multiple edits.
// Rewritten expressions point to their original start; injected imports stay unmapped.
export class SourceRewriter {
  constructor(original, sourcemap = false) {
    this.original = original;
    this.text = original;
    this.sourcemap = sourcemap;
    this.offsets = undefined;
  }

  replace(pattern, replacement, all = false) {
    let cursor = 0;
    const pieces = [];
    const rewrite = (match, ...args) => {
      const start = args.at(-2);
      const value = typeof replacement === 'function' ? replacement(match, ...args) : replacement;
      this.trackOffsets();
      this.recordEdit(pieces, cursor, start, value.length);
      cursor = start + match.length;
      return value;
    };
    const text = all ? this.text.replaceAll(pattern, rewrite) : this.text.replace(pattern, rewrite);
    if (this.offsets) this.offsets = pieces.concat(this.offsets.slice(cursor));
    this.text = text;
    return this;
  }

  trackOffsets() {
    if (this.sourcemap && !this.offsets) this.offsets = Array.from({ length: this.original.length }, (_, i) => i);
  }

  recordEdit(pieces, cursor, start, length) {
    if (!this.offsets) return;
    for (const offset of this.offsets.slice(cursor, start)) pieces.push(offset);
    for (let i = 0; i < length; i++) pieces.push(this.offsets[start] ?? -1);
  }

  replaceAll(pattern, replacement) {
    return this.replace(pattern, replacement, true);
  }

  prepend(text) {
    this.trackOffsets();
    if (this.offsets) this.offsets = Array(text.length).fill(-1).concat(this.offsets);
    this.text = text + this.text;
    return this;
  }

  contents(file) {
    if (!this.sourcemap || (this.text === this.original && !upstreamMap.test(this.text))) return this.text;
    this.trackOffsets();
    // The last directive wins: override upstream maps without regex-editing JS
    // comments (which could actually be string/template literal contents).
    const map = { version: 3, sources: [file], sourcesContent: [this.original], names: [],
      mappings: mappingsFor(this.text, this.offsets, this.original) };
    return this.text + '\n//# sourceMappingURL=data:application/json;base64,'
      + Buffer.from(JSON.stringify(map)).toString('base64');
  }
}
