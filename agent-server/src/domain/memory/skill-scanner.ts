import { readdirSync, existsSync } from 'fs';
import * as path from 'path';
import { DATA_DIR, PLUGINS_DIR } from '@core/paths.js';
import { createLogger } from '@core/log.js';

const log = createLogger('skill-scanner');

const SKILL_SCAN_CACHE_MS = 60 * 1000;
// User-mutable skill roots under DATA_DIR — populated by `cortex init` (copy from defaults/)
// and editable by the user. INSTALL_ROOT/.claude is immutable package code, not scanned here.
const CLAUDE_SKILL_ROOT = path.join(DATA_DIR, '.claude', 'skills');
const PLUGINS_ROOT = PLUGINS_DIR;

let cachedDisplayGroups = [];
let cachedDisplayGroupsAt = 0;

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

/** Reset the in-process scan cache. Use only in tests that create/delete skill files mid-run. */
function clearSkillScanCache(): void {
  cachedDisplayGroupsAt = 0;
}

export { getDisplaySkillGroups, clearSkillScanCache };
