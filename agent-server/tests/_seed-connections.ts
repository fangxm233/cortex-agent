// Connection fixtures for selection tests. Everything lands in the per-file isolated home
// (tests/_vitest-setup.ts), and every credential is an obviously fake value.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { CONNECTIONS_FILE, upsertConnection, type ClaudeKeyConnection } from '../src/core/connections-file.js';
import { CLAUDE_CONFIG_HOME } from '../src/core/paths.js';

const CLAUDE_STORE = path.join(CLAUDE_CONFIG_HOME, '.credentials.json');

/** Give this home Claude Code's own login, so the implicit `subscription` connection exists. */
export function seedClaudeSubscription(): void {
  mkdirSync(CLAUDE_CONFIG_HOME, { recursive: true });
  writeFileSync(CLAUDE_STORE, JSON.stringify({
    claudeAiOauth: { accessToken: 'fake-access-token', refreshToken: 'fake-refresh-token' },
  }));
}

/** Store a Claude key connection on the official API (or a relay, given a base URL). */
export function seedClaudeKeyConnection(id = 'api', extra: Partial<ClaudeKeyConnection> = {}): void {
  upsertConnection({
    id, backend: 'claude', label: id, authStyle: 'x-api-key', key: `sk-test-${id}-fake`, billing: 'metered', ...extra,
  });
}

/** Remove every connection seeded above. */
export function clearSeededConnections(): void {
  rmSync(CLAUDE_STORE, { force: true });
  rmSync(CONNECTIONS_FILE, { force: true });
}
