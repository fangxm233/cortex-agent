// input:  redacted MCP drafts from the server and operator form edits
// output: name validation plus the editable MCP model and its write payload
// pos:    Pure view model for the plugin authoring surface
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { PluginsMcpRead, PluginsMcpServerInput, UiPluginMcpDraft } from '@cortex-agent/ui-contract';

/** The canonical Agent Skills name, matched by the server before it touches the filesystem. */
const NAME_RE = /^(?!.*--)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function isCanonicalName(value: string): boolean {
  return value.length > 0 && value.length <= 64 && NAME_RE.test(value);
}

export type McpTransport = 'stdio' | 'streamable-http' | 'sse';

/** `value === null` means the value already on disk stays there — this page was never told it. */
export interface McpSecretRow {
  key: string;
  value: string | null;
}

export interface McpServerDraft {
  /** Stable across renames so a React key never has to be the editable name. */
  id: string;
  name: string;
  type: McpTransport;
  command: string;
  argsText: string;
  cwd: string;
  url: string;
  secrets: McpSecretRow[];
}

function keptSecrets(keys: readonly string[]): McpSecretRow[] {
  return keys.map((key) => ({ key, value: null }));
}

export function draftFromServer(server: UiPluginMcpDraft, id: string): McpServerDraft {
  if (server.type === 'stdio') {
    return {
      id,
      name: server.name,
      type: 'stdio',
      command: server.command,
      argsText: server.args.join('\n'),
      cwd: server.cwd ?? '',
      url: '',
      secrets: keptSecrets(server.envKeys),
    };
  }
  return {
    id,
    name: server.name,
    type: server.type,
    command: '',
    argsText: '',
    cwd: '',
    url: server.url,
    secrets: keptSecrets(server.headerKeys),
  };
}

export function draftsFromRead(read: PluginsMcpRead | undefined): McpServerDraft[] {
  return (read?.servers ?? []).map((server, index) => draftFromServer(server, `s${index}`));
}

export function emptyDraft(id: string): McpServerDraft {
  return { id, name: '', type: 'stdio', command: '', argsText: '', cwd: '', url: '', secrets: [] };
}

function argsList(argsText: string): string[] {
  return argsText.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}

function secretMap(secrets: readonly McpSecretRow[]): Record<string, string | null> | undefined {
  const rows = secrets.filter((row) => row.key.trim().length > 0);
  if (rows.length === 0) return undefined;
  return Object.fromEntries(rows.map((row) => [row.key.trim(), row.value]));
}

export function toInput(draft: McpServerDraft): PluginsMcpServerInput {
  if (draft.type === 'stdio') {
    const args = argsList(draft.argsText);
    return {
      name: draft.name.trim(),
      type: 'stdio',
      command: draft.command.trim(),
      ...(args.length > 0 ? { args } : {}),
      ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
      ...(secretMap(draft.secrets) ? { env: secretMap(draft.secrets) } : {}),
    };
  }
  return {
    name: draft.name.trim(),
    type: draft.type,
    url: draft.url.trim(),
    ...(secretMap(draft.secrets) ? { headers: secretMap(draft.secrets) } : {}),
  };
}

export type McpDraftIssue =
  | 'name-missing'
  | 'name-duplicate'
  | 'command-missing'
  | 'url-missing'
  | 'secret-key-duplicate';

/** Blocks the save button. The server re-checks all of it — this only spares a round trip. */
export function mcpDraftIssues(drafts: readonly McpServerDraft[]): McpDraftIssue[] {
  const issues = new Set<McpDraftIssue>();
  const names = new Set<string>();
  for (const draft of drafts) {
    const name = draft.name.trim();
    if (name.length === 0) issues.add('name-missing');
    else if (names.has(name)) issues.add('name-duplicate');
    names.add(name);
    if (draft.type === 'stdio' && draft.command.trim().length === 0) issues.add('command-missing');
    if (draft.type !== 'stdio' && draft.url.trim().length === 0) issues.add('url-missing');
    if (hasDuplicateKey(draft.secrets)) issues.add('secret-key-duplicate');
  }
  return [...issues];
}

function hasDuplicateKey(secrets: readonly McpSecretRow[]): boolean {
  const seen = new Set<string>();
  for (const row of secrets) {
    const key = row.key.trim();
    if (key.length === 0) continue;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

export function sameMcpDrafts(
  left: readonly McpServerDraft[],
  right: readonly McpServerDraft[],
): boolean {
  return JSON.stringify(left.map(toInput)) === JSON.stringify(right.map(toInput));
}

/** Replace one draft in a list by id, returning a new list. */
export function replaceDraft(
  drafts: readonly McpServerDraft[],
  id: string,
  patch: Partial<McpServerDraft>,
): McpServerDraft[] {
  return drafts.map((draft) => (draft.id === id ? { ...draft, ...patch } : draft));
}
