// input:  contained SKILL.md files, yaml
// output: valid skill entries plus frontmatter issues
// pos:    Agent Skills frontmatter validator
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

function validName(name: unknown, expected: string): boolean {
  return typeof name === 'string'
    && name === expected
    && name.length <= 64
    && SKILL_NAME_RE.test(name);
}

function validDescription(description: unknown): boolean {
  return typeof description === 'string'
    && description.trim().length > 0
    && description.length <= 1024;
}

function stringIssue(name: string, field: string, message: string): PluginCatalogIssue[] {
  return [makeIssue(name, `SKILL.md frontmatter ${field} ${message}`)];
}

function unknownFieldIssues(name: string, meta: Record<string, unknown>): PluginCatalogIssue[] {
  const keys = Object.keys(meta).filter((key) => !SKILL_FIELDS.has(key)).sort();
  if (keys.length === 0) return [];
  return [makeIssue(name, `SKILL.md frontmatter contains unknown fields: ${keys.join(', ')}`)];
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
  pushOptionalIssue(issues, name, meta['allowed-tools'] !== undefined && typeof meta['allowed-tools'] !== 'string', 'allowed-tools', 'must be a string when present');
  return issues;
}

function validateSkill(name: string, text: string): PluginCatalogIssue[] {
  const meta = frontmatter(text);
  if (!meta) return [makeIssue(name, 'SKILL.md must start with YAML frontmatter')];
  if (!validName(meta.name, name)) {
    return [makeIssue(name, 'SKILL.md frontmatter name must match the skill directory')];
  }
  if (!validDescription(meta.description)) {
    return [makeIssue(name, 'SKILL.md frontmatter description must be non-empty')];
  }
  return [...optionalFieldIssues(name, meta), ...unknownFieldIssues(name, meta)];
}

export function loadSkillFile(name: string, filePath: string): SkillLoadResult {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const issues = validateSkill(name, text);
    if (issues.length > 0) return { issues };
    return { skill: { name, dir: path.join('skills', name) }, issues: [] };
  } catch {
    return { issues: [makeIssue(name, 'SKILL.md could not be read')] };
  }
}
