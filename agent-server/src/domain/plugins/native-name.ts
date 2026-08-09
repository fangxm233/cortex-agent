// input:  arbitrary plugin and tool names
// output: bounded safe backend and manifest names
// pos:    Collision-safe portable plugin name mapper
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { createHash } from 'node:crypto';

const SAFE_RE = /[^A-Za-z0-9_-]+/g;
const KEBAB_RE = /[^a-z0-9]+/g;
const MAX_NATIVE_NAME = 64;
const HASH_LEN = 10;
const HASH_SEP = '_';
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;

function shortHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, HASH_LEN);
}

function squash(value: string, pattern: RegExp, glue: string): string {
  return value.replace(pattern, glue).replace(new RegExp(`${glue}+`, 'g'), glue);
}

function trimGlue(value: string, glue: string): string {
  return value.replace(new RegExp(`^${glue}+|${glue}+$`, 'g'), '');
}

function bounded(base: string, raw: string, glue: string): string {
  const hash = `${glue}${shortHash(raw)}`;
  const limit = MAX_NATIVE_NAME - hash.length;
  return `${base.slice(0, Math.max(1, limit))}${hash}`;
}

function needsHash(cleaned: string, raw: string): boolean {
  return cleaned !== raw || cleaned.length > MAX_NATIVE_NAME;
}

export function safeNativeName(raw: string, fallback = 'plugin'): string {
  const cleaned = trimGlue(squash(raw, SAFE_RE, '_'), '_') || fallback;
  if (!needsHash(cleaned, raw)) return cleaned;
  return bounded(cleaned, raw, HASH_SEP);
}

export function safeNativeComposite(parts: readonly string[], prefix = 'plugin'): string {
  const cleanedParts = parts.map((part) => trimGlue(squash(part, SAFE_RE, '_'), '_') || 'part');
  const cleaned = trimGlue([prefix, ...cleanedParts].join('_'), '_') || prefix;
  return bounded(cleaned, JSON.stringify({ prefix, parts: [...parts] }), HASH_SEP);
}

function kebabBase(raw: string): string {
  const cleaned = trimGlue(squash(raw.toLowerCase(), KEBAB_RE, '-'), '-') || 'plugin';
  return /^[a-z]/.test(cleaned) ? cleaned : `plugin-${cleaned}`;
}

export function safeClaudeManifestName(raw: string): string {
  const cleaned = kebabBase(raw);
  if (!needsHash(cleaned, raw)) return cleaned;
  return bounded(cleaned, raw, '-');
}

function normalizedVersion(value: string): string | undefined {
  const cleaned = trimGlue(squash(value.toLowerCase(), /[^a-z0-9._-]+/g, '-'), '-');
  return VERSION_RE.test(cleaned) ? cleaned : undefined;
}

export function safeClaudeManifestVersion(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  if (VERSION_RE.test(trimmed)) return trimmed;
  return normalizedVersion(trimmed);
}
