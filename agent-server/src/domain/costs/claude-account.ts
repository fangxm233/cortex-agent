import { randomUUID } from 'node:crypto';
import { loadClaudeAccountCredentials } from '@domain/auth/claude-account-credentials.js';
import type { UsageResetCredit, UsageResetCredits } from './usage-store.js';
import type { AccountReading, AccountRedeemOutcome, AccountWindow, ResetAccount } from './reset-account.js';

/** Anthropic API host that serves Claude subscription usage and usage-limit resets. */
export const ANTHROPIC_API_URL = 'https://api.anthropic.com';
const REQUEST_TIMEOUT_MS = 10_000;
/** `cedar_ember` is the program that carries banked usage-limit resets. */
const USAGE_PATH = '/api/oauth/usage?cedar_ember=1&skip_spend=1';
const RESET_PROGRAM = 'cedar_ember';
const GRANT_ID = /^[a-z0-9_-]{1,40}$/;
/** The account windows the gateway quota path also reports, so both sources fill one row. */
const WINDOW_TYPES = ['five_hour', 'seven_day'] as const;

const CLAIM_STATUS: Record<string, AccountRedeemOutcome['status']> = {
  reset: 'reset',
  already_used: 'already_redeemed',
  not_limited: 'nothing_to_reset',
  cooldown: 'cooldown',
  ineligible: 'ineligible',
  unavailable: 'no_credit',
};

export interface ClaudeAccountCredentials {
  headers: Record<string, string>;
  organizationUuid: string;
  /** Claude Code's client identity; the account only offers resets to a current Claude Code. */
  userAgent: string;
}

/** Resolves null when Claude's own OAuth login (`claude login`) is not usable here. */
export type ClaudeCredentialSource = () => Promise<ClaudeAccountCredentials | null>;

export interface ClaudeAccountClientDeps {
  credentials: ClaudeCredentialSource;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  /** Idempotency key for one claim request. */
  requestId?: () => string;
}

interface UsableGrant extends UsageResetCredit {
  left: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isoSeconds(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Claude reports utilization in percent; an idle window may have no reset time yet. */
function usageWindow(raw: unknown, type: string): AccountWindow | null {
  if (!isRecord(raw)) return null;
  const used = finite(raw.utilization);
  if (used === null || used < 0 || used > 100) return null;
  return { type, utilization: used / 100, resetsAt: isoSeconds(raw.resets_at) };
}

function usableGrant(raw: unknown): UsableGrant | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !GRANT_ID.test(raw.id)) return null;
  const left = finite(raw.resets_left) ?? 0;
  if (raw.usable_now !== true || raw.paused === true || left <= 0) return null;
  return {
    id: raw.id,
    title: typeof raw.label === 'string' ? raw.label : null,
    expiresAt: isoSeconds(raw.ends_at),
    clears: strings(raw.clears),
    left: Math.floor(left),
  };
}

function byExpiry(a: UsageResetCredit, b: UsageResetCredit): number {
  return (a.expiresAt ?? Number.POSITIVE_INFINITY) - (b.expiresAt ?? Number.POSITIVE_INFINITY);
}

function resetCredits(status: Record<string, unknown>): UsageResetCredits {
  const grants = (Array.isArray(status.grants) ? status.grants : [])
    .flatMap((raw) => {
      const grant = usableGrant(raw);
      return grant ? [grant] : [];
    })
    .sort(byExpiry);
  // The account's own pick counts only when it names a grant that is usable right now.
  const next = grants.find((grant) => grant.id === status.next_grant_id)?.id;
  return {
    availableCount: grants.reduce((sum, grant) => sum + grant.left, 0),
    atLimit: status.at_limit === true,
    credits: grants.map(({ left: _left, ...credit }) => credit),
    ...(next ? { nextCreditId: next } : {}),
  };
}

/** Parse `GET /api/oauth/usage?cedar_ember=1`. A response without a usable window is an error. */
export function parseClaudeUsage(payload: unknown): AccountReading {
  if (!isRecord(payload)) throw new Error('Claude usage response is not an object');
  const windows = WINDOW_TYPES.flatMap((type) => {
    const window = usageWindow(payload[type], type);
    return window ? [window] : [];
  });
  if (windows.length === 0) throw new Error('Claude usage response has no rate-limit window');
  const status = isRecord(payload.cedar_ember) ? payload.cedar_ember : null;
  return { windows, resetCredits: status ? resetCredits(status) : null };
}

export function parseClaimOutcome(payload: unknown): AccountRedeemOutcome {
  const result = isRecord(payload) ? payload.result : undefined;
  const status = typeof result === 'string' && Object.hasOwn(CLAIM_STATUS, result) ? CLAIM_STATUS[result] : undefined;
  if (!status) throw new Error(`Claude reset returned an unexpected result: ${String(result)}`);
  return { status, cleared: strings((payload as Record<string, unknown>).cleared) };
}

function httpError(what: string, status: number): Error {
  if (status === 429) return new Error(`Claude ${what} request was rate limited (HTTP 429)`);
  if (status === 401 || status === 403) return new Error(`Claude ${what} authorization failed (HTTP ${status})`);
  return new Error(`Claude ${what} HTTP ${status}`);
}

export class HttpClaudeAccountClient implements ResetAccount {
  private readonly fetch: typeof globalThis.fetch;
  private readonly baseUrl: string;
  private readonly requestId: () => string;

  constructor(private readonly deps: ClaudeAccountClientDeps) {
    this.fetch = deps.fetch ?? globalThis.fetch;
    this.baseUrl = deps.baseUrl ?? ANTHROPIC_API_URL;
    this.requestId = deps.requestId ?? randomUUID;
  }

  async readUsage(): Promise<AccountReading | null> {
    const credentials = await this.deps.credentials();
    if (!credentials) return null;
    return parseClaudeUsage(await this.request(credentials, 'usage', 'GET', USAGE_PATH));
  }

  /** Spends one reset from the given grant. Claude always needs the grant named. */
  async redeemReset(grantId?: string): Promise<AccountRedeemOutcome | null> {
    const credentials = await this.deps.credentials();
    if (!credentials) return null;
    if (!grantId) return { status: 'no_credit', cleared: [] };
    if (!GRANT_ID.test(grantId)) throw new Error(`Invalid Claude reset grant: ${grantId}`);
    const path = `/api/organizations/${encodeURIComponent(credentials.organizationUuid)}/reset_rate_limits`;
    const body = { program: RESET_PROGRAM, grant_id: grantId, request_id: this.requestId() };
    return parseClaimOutcome(await this.request(credentials, 'reset', 'POST', path, body));
  }

  private async request(
    credentials: ClaudeAccountCredentials,
    what: string,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { ...credentials.headers, 'content-type': 'application/json', 'user-agent': credentials.userAgent },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw httpError(what, response.status);
    return response.json();
  }
}

/** The daemon's Claude account, signed in through Claude Code's own OAuth login. */
export const claudeAccountClient: ResetAccount = new HttpClaudeAccountClient({
  credentials: () => loadClaudeAccountCredentials(),
});
