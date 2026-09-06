// input:  contained SKILL.md files, yaml
// output: skill entries plus fatal/advisory frontmatter issues
// pos:    Agent Skills frontmatter validator (lenient: only unusable skills are dropped)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import fs from 'node:fs';
import path from 'node:path';
import { parse as yamlParse } from 'yaml';
import { isPlainObject } from './fs-helpers.js';
import type { PluginCatalogIssue, PluginCatalogSkill } from './catalog-types.js';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const SKILL_NAME_RE = /^(?!.*--)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SKILL_FIELDS = new Set([
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
]);

interface SkillLoadResult {
  skill?: PluginCatalogSkill;
  issues: PluginCatalogIssue[];
}

function issuePath(name: string): string {
  return `skills.${name}.SKILL.md`;
}

function makeIssue(name: string, message: string): PluginCatalogIssue {
  return {
    code: 'skill_invalid',
    scope: 'skill',
    path: issuePath(name),
    message,
  };
}

/** Reported but not disqualifying. Spec deviations here cost nothing at runtime: Cortex keeps only
 *  the skill's name and directory, and the backend reads SKILL.md itself. Dropping a working skill
 *  over a stray frontmatter key is a worse failure than tolerating the key, and it is a silent one. */
function makeAdvisory(name: string, message: string): PluginCatalogIssue {
  return {
    code: 'skill_frontmatter_ignored',
    scope: 'skill',
    path: issuePath(name),
    message,
  };
}

function frontmatter(text: string): Record<string, unknown> | null {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) return null;
  try {
    const parsed = yamlParse(match[1]);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Fatal: a name that disagrees with its directory makes the skill's identity ambiguous, since
 *  Cortex addresses it by directory while the backend reads the frontmatter. An absent name is
 *  merely advisory — the directory answers it. */
function conflictingName(name: unknown, expected: string): boolean {
  return name !== undefined && !(typeof name === 'string' && name === expected);
}

function validDescription(description: unknown): boolean {
  return typeof description === 'string' && description.trim().length > 0;
}

function stringIssue(name: string, field: string, message: string): PluginCatalogIssue[] {
  return [makeAdvisory(name, `SKILL.md frontmatter ${field} ${message}`)];
}

function unknownFieldIssues(name: string, meta: Record<string, unknown>): PluginCatalogIssue[] {
  const keys = Object.keys(meta).filter((key) => !SKILL_FIELDS.has(key)).sort();
  if (keys.length === 0) return [];
  return [makeAdvisory(name, `SKILL.md frontmatter has fields outside the spec, ignored: ${keys.join(', ')}`)];
}

function shapeIssues(name: string, meta: Record<string, unknown>): PluginCatalogIssue[] {
  const issues: PluginCatalogIssue[] = [];
  if (meta.name === undefined) issues.push(...stringIssue(name, 'name', 'is absent; the directory name is used'));
  else if (typeof meta.name === 'string' && (meta.name.length > 64 || !SKILL_NAME_RE.test(meta.name))) {
    issues.push(...stringIssue(name, 'name', 'is not a canonical Agent Skills name'));
  }
  if (typeof meta.description === 'string' && meta.description.length > 1024) {
    issues.push(...stringIssue(name, 'description', 'exceeds the 1024-character guidance'));
  }
  return issues;
}

function metadataStrings(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return Object.values(value).every((item) => typeof item === 'string');
}

function pushOptionalIssue(
  issues: PluginCatalogIssue[],
  name: string,
  invalid: boolean,
  field: string,
  message: string,
): void {
  if (invalid) issues.push(...stringIssue(name, field, message));
}

function optionalFieldIssues(name: string, meta: Record<string, unknown>): PluginCatalogIssue[] {
  const issues: PluginCatalogIssue[] = [];
  pushOptionalIssue(issues, name, meta.license !== undefined && typeof meta.license !== 'string', 'license', 'must be a string when present');
  pushOptionalIssue(issues, name, meta.compatibility !== undefined && (!validDescription(meta.compatibility) || String(meta.compatibility).length > 500), 'compatibility', 'must be 1-500 characters when present');
  pushOptionalIssue(issues, name, meta.metadata !== undefined && !metadataStrings(meta.metadata), 'metadata', 'must be a string-to-string map when present');
  pushOptionalIssue(issues, name, meta['allowed-tools'] !== undefined && !isToolList(meta['allowed-tools']), 'allowed-tools', 'should be a comma-separated string');
  return issues;
}

/** A YAML list is the shape everyone writes by hand; accept it alongside the spec's string. */
function isToolList(value: unknown): boolean {
  return typeof value === 'string'
    || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
}

/** Fatal issues only. Everything survivable is reported by {@link advisoryIssues} instead. */
function fatalIssues(name: string, meta: Record<string, unknown> | null): PluginCatalogIssue[] {
  if (!meta) return [makeIssue(name, 'SKILL.md must start with YAML frontmatter')];
  if (conflictingName(meta.name, name)) {
    return [makeIssue(name, 'SKILL.md frontmatter name must match the skill directory')];
  }
  if (!validDescription(meta.description)) {
    return [makeIssue(name, 'SKILL.md frontmatter description must be non-empty')];
  }
  return [];
}

function advisoryIssues(name: string, meta: Record<string, unknown>): PluginCatalogIssue[] {
  return [...shapeIssues(name, meta), ...optionalFieldIssues(name, meta), ...unknownFieldIssues(name, meta)];
}

export function loadSkillFile(name: string, filePath: string): SkillLoadResult {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { issues: [makeIssue(name, 'SKILL.md could not be read')] };
  }
  const meta = frontmatter(text);
  const fatal = fatalIssues(name, meta);
  if (fatal.length > 0 || !meta) return { issues: fatal };
  return { skill: { name, dir: path.join('skills', name) }, issues: advisoryIssues(name, meta) };
}
