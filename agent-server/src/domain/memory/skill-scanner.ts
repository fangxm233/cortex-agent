// input:  DATA_DIR/.claude/skills and DATA_DIR/plugins/*/skills
// output: getKnown/Display/Groups + normalize prefix
// pos:    skill discovery and command prefix normalization
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { readdirSync, existsSync } from 'fs';
import * as path from 'path';
import { DATA_DIR, PLUGINS_DIR } from '@core/utils.js';
import { createLogger } from '@core/log.js';

const log = createLogger('skill-scanner');

const SKILL_SCAN_CACHE_MS = 60 * 1000;
// User-mutable skill roots under DATA_DIR — populated by `cortex init` (copy from defaults/)
// and editable by the user. INSTALL_ROOT/.claude is immutable package code, not scanned here.
const CLAUDE_SKILL_ROOT = path.join(DATA_DIR, '.claude', 'skills');
const PLUGINS_ROOT = PLUGINS_DIR;

let cachedDisplayGroups = [];
let cachedDisplayGroupsAt = 0;
let cachedKnownNames = new Set();
let cachedKnownNamesAt = 0;

function listSubdirectories(dir) {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch (error) {
    log.warn(`Failed to list directories: ${dir} (${error.message})`);
    return [];
  }
}

function collectSkillNamesFromRoot(rootDir) {
  if (!existsSync(rootDir)) return [];
  const names = [];
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
      names.push(path.basename(dir).toLowerCase());
    }

    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
    }
  }
  return names;
}

function collectPluginSkillGroups() {
  if (!existsSync(PLUGINS_ROOT)) return [];
  const groups = [];
  for (const pluginDir of listSubdirectories(PLUGINS_ROOT)) {
    const skillsRoot = path.join(pluginDir, 'skills');
    const skills = [...new Set(collectSkillNamesFromRoot(skillsRoot))].sort();
    if (skills.length) {
      groups.push({ plugin: path.basename(pluginDir).toLowerCase(), skills });
    }
  }
  groups.sort((a, b) => a.plugin.localeCompare(b.plugin));
  return groups;
}

function getDisplaySkillGroups() {
  const now = Date.now();
  if (now - cachedDisplayGroupsAt < SKILL_SCAN_CACHE_MS) return cachedDisplayGroups;

  const groups = [];
  const claudeSkills = [...new Set(collectSkillNamesFromRoot(CLAUDE_SKILL_ROOT))].sort();
  if (claudeSkills.length) groups.push({ plugin: null, skills: claudeSkills });
  groups.push(...collectPluginSkillGroups());

  cachedDisplayGroups = groups;
  cachedDisplayGroupsAt = now;
  return groups;
}

function getDisplaySkillNames() {
  const names = new Set();
  for (const group of getDisplaySkillGroups()) {
    for (const skill of group.skills) names.add(skill);
  }
  return names;
}

function getKnownSkillNames() {
  const now = Date.now();
  if (now - cachedKnownNamesAt < SKILL_SCAN_CACHE_MS) return cachedKnownNames;

  const names = new Set();
  for (const name of collectSkillNamesFromRoot(CLAUDE_SKILL_ROOT)) names.add(name);
  for (const { plugin, skills } of collectPluginSkillGroups()) {
    for (const skill of skills) {
      names.add(skill);
      names.add(`${plugin}:${skill}`);
    }
  }
  cachedKnownNames = names;
  cachedKnownNamesAt = now;
  return names;
}

function normalizeSkillCommandPrefix(messageText) {
  if (typeof messageText !== 'string') return '';
  const trimmedStart = messageText.trimStart();
  if (!trimmedStart) return messageText;
  if (trimmedStart.startsWith('/') || trimmedStart.startsWith('!')) return messageText;

  const firstToken = trimmedStart.match(/^(\S+)/)?.[1];
  if (!firstToken) return messageText;

  if (!getKnownSkillNames().has(firstToken.toLowerCase())) return messageText;
  return `/${trimmedStart}`;
}

/** Reset the in-process scan cache. Use only in tests that create/delete skill files mid-run. */
function clearSkillScanCache(): void {
  cachedDisplayGroupsAt = 0;
  cachedKnownNamesAt = 0;
}

export { getKnownSkillNames, getDisplaySkillNames, getDisplaySkillGroups, normalizeSkillCommandPrefix, clearSkillScanCache };
