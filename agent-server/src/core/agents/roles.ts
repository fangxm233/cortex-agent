// input:  role markdown under DATA_DIR/config/agents, the shipped defaults, the legacy PI role dir
// output: parsed AgentRole records, per-backend tool lists, seeding and one-time migration
// pos:    The one role table both backends delegate through
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync,
  constants as fsConstants,
} from 'node:fs';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import { parse as yamlParse } from 'yaml';
import { CONFIG_DIR, DEFAULTS_DIR } from '@core/paths.js';
import { createLogger } from '@core/log.js';
import { MCP_TOOLS_BY_SERVER } from '@core/mcp-tool-gate.js';
import { fromCanonical } from '@core/tool-names.js';
import type { Backend } from '@core/types/agent-types.js';

const log = createLogger('agent-roles');

/** The live, user-editable role table. One directory, both backends. */
export const AGENT_ROLES_DIR = path.join(CONFIG_DIR, 'agents');
/** The shipped seed, copied in if-missing so user edits always survive. */
export const DEFAULT_AGENT_ROLES_DIR = path.join(DEFAULTS_DIR, 'agents');

export const BUILTIN_AGENT_ROLE_NAMES = ['explore', 'general-purpose', 'plan'] as const;

/** Every bundle is served under the one `cortex-core` server name, so an MCP tool named in a role
 *  file resolves to a single Claude-side spelling regardless of which bundle declares it. */
const MCP_TOOL_PREFIX = 'mcp__cortex-core__';
const KNOWN_MCP_TOOLS = new Set(Object.values(MCP_TOOLS_BY_SERVER).flat());

export interface AgentRole {
  name: string;
  description: string;
  /** Canonical tool names; translated per backend by {@link roleToolsForBackend}. */
  tools?: string[];
  /** Default model spec — `provider/model[:thinking]` for pi, a bare model id for claude. */
  model?: string;
  /** Default backend. Absent means "inherit the delegating parent's". */
  backend?: Backend;
  /** Explicit gateway route for the child; absent falls back to the provider name (plan §3.2). */
  mode?: string;
  systemPrompt: string;
}

function parseTools(value: unknown): string[] | undefined {
  const tools = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : typeof value === 'string' ? value.split(',') : [];
  const normalized = tools.map((tool) => tool.trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function parseBackend(value: unknown): Backend | undefined {
  return value === 'claude' || value === 'pi' ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Markdown with YAML frontmatter. A file without `name` + `description` is not a role. */
export function parseRole(content: string): AgentRole | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(content);
  if (!match) return null;
  const frontmatter = yamlParse(match[1]) as Record<string, unknown> | null;
  if (!frontmatter || typeof frontmatter.name !== 'string') return null;
  if (typeof frontmatter.description !== 'string') return null;
  return {
    name: frontmatter.name,
    description: frontmatter.description,
    tools: parseTools(frontmatter.tools),
    model: optionalString(frontmatter.model),
    backend: parseBackend(frontmatter.backend),
    mode: optionalString(frontmatter.mode),
    systemPrompt: match[2].trim(),
  };
}

export function loadRoles(rolesDir: string = AGENT_ROLES_DIR): AgentRole[] {
  const roles: AgentRole[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(rolesDir, { withFileTypes: true });
  } catch {
    return roles;
  }
  for (const entry of entries) {
    if (!entry.name.endsWith('.md')) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const role = parseRole(readFileSync(path.join(rolesDir, entry.name), 'utf8'));
    if (role) roles.push(role);
  }
  return roles;
}

export function findRole(roles: AgentRole[], name: string): AgentRole {
  const role = roles.find((candidate) => candidate.name === name);
  if (role) return role;
  const available = roles.map((candidate) => candidate.name).sort().join(', ') || 'none';
  throw new Error(`Unknown subagent_type "${name}". Available roles: ${available}.`);
}

/**
 * A role's tool list in one backend's own spelling.
 *
 * PI answers to the canonical names directly and tolerates extras (its own `find`, `ls`, and the
 * bare MCP names its in-process bridge registers), so PI gets the list through unchanged apart
 * from the canonical map. Claude's `--tools` rejects names it does not know, so a name that maps
 * to nothing on that side is dropped rather than passed through.
 */
export function roleToolsForBackend(role: AgentRole, backend: Backend): string[] | undefined {
  if (!role.tools) return undefined;
  const resolved: string[] = [];
  for (const tool of role.tools) {
    if (tool.startsWith('mcp__')) { resolved.push(tool); continue; }
    const native = fromCanonical(backend, tool);
    if (native) { resolved.push(native); continue; }
    if (KNOWN_MCP_TOOLS.has(tool)) {
      resolved.push(backend === 'claude' ? MCP_TOOL_PREFIX + tool : tool);
      continue;
    }
    if (backend !== 'claude') resolved.push(tool);
  }
  return [...new Set(resolved)];
}

export interface EnsureAgentRolesOpts {
  rolesDir?: string;
  defaultsDir?: string;
  /** Pre-unification PI role dir. Adopted wholesale the first time, then never read again. */
  legacyDir?: string;
}

/**
 * Make the shared role dir exist and hold the built-ins.
 *
 * Seeding is copy-if-missing (`COPYFILE_EXCL`), so a role the user has edited is never clobbered.
 * Migration is guarded by the target dir's own absence rather than a version sentinel: once
 * `config/agents/` exists this is a pure top-up, so re-adoption cannot resurrect a role the user
 * has since deleted.
 */
export function ensureAgentRoles(opts: EnsureAgentRolesOpts = {}): void {
  const rolesDir = opts.rolesDir ?? AGENT_ROLES_DIR;
  const defaultsDir = opts.defaultsDir ?? DEFAULT_AGENT_ROLES_DIR;
  const firstRun = !existsSync(rolesDir);
  mkdirSync(rolesDir, { recursive: true });
  if (firstRun && opts.legacyDir) adoptLegacyRoles(opts.legacyDir, rolesDir);
  for (const name of BUILTIN_AGENT_ROLE_NAMES) {
    copyIfMissing(path.join(defaultsDir, `${name}.md`), path.join(rolesDir, `${name}.md`));
  }
}

/**
 * Move a pre-unification PI role dir into the shared table, then rename it aside.
 *
 * The rename is the point: copying alone would leave a directory that still looks live, and a user
 * editing a role there would silently change nothing. `.migrated` keeps their files but makes it
 * obvious they are no longer the ones being read.
 */
function adoptLegacyRoles(legacyDir: string, rolesDir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(legacyDir).filter((name) => name.endsWith('.md'));
  } catch {
    return;
  }
  for (const name of entries) {
    copyIfMissing(path.join(legacyDir, name), path.join(rolesDir, name));
  }
  if (!entries.length) return;
  log.info(`Adopted ${entries.length} role file(s) from ${legacyDir}`);
  try {
    renameSync(legacyDir, `${legacyDir}.migrated`);
  } catch (error) {
    log.warn(`Could not retire ${legacyDir}: ${(error as Error).message}`);
  }
}

function copyIfMissing(source: string, target: string): void {
  try {
    copyFileSync(source, target, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return;
    if (code === 'ENOENT') { log.warn(`Role seed missing: ${source}`); return; }
    throw error;
  }
}
