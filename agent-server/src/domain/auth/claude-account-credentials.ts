import { claudeLoginHeaders, readClaudeOrganizationUuid, type ClaudeCredentialDeps } from '@core/claude-credentials.js';
import { runFile } from '@core/exec-async.js';
import type { ClaudeAccountCredentials } from '@domain/costs/claude-account.js';

const VERSION_TIMEOUT_MS = 5_000;

export interface ClaudeAccountCredentialDeps extends ClaudeCredentialDeps {
  /** The installed Claude Code version, or null when it cannot be told. */
  cliVersion?: () => Promise<string | null>;
}

async function installedClaudeVersion(): Promise<string | null> {
  const result = await runFile('claude', ['--version'], { timeoutMs: VERSION_TIMEOUT_MS });
  return result.ok ? result.stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null : null;
}

/**
 * Claude's own OAuth login plus the organization it belongs to. Null when there is no live login
 * token — Cortex cannot refresh one, only Claude Code can — or no organization on record. The
 * account offers banked resets only to Claude Code itself, so requests carry the installed Claude
 * Code's client identity.
 */
export async function loadClaudeAccountCredentials(
  deps: ClaudeAccountCredentialDeps = {},
): Promise<ClaudeAccountCredentials | null> {
  const headers = claudeLoginHeaders(deps);
  const organizationUuid = readClaudeOrganizationUuid(deps);
  if (!headers || !organizationUuid) return null;
  const version = await (deps.cliVersion ?? installedClaudeVersion)();
  const client = version ? `claude-cli/${version}` : 'claude-cli';
  return { headers, organizationUuid, userAgent: `${client} (external, cli)` };
}
