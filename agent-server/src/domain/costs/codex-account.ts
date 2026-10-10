import { randomUUID } from 'node:crypto';
import type { QuotaWindow } from '@core/codex-quota.js';
import { loadCodexCredentials } from '@domain/auth/codex-credentials.js';
import type { UsageResetCredit, UsageResetCredits } from './usage-store.js';

/** ChatGPT backend that serves Codex account usage and banked rate-limit resets. */
export const CODEX_BACKEND_URL = 'https://chatgpt.com/backend-api';
const REQUEST_TIMEOUT_MS = 10_000;
const USAGE_PATH = '/wham/usage';
const CREDITS_PATH = '/wham/rate-limit-reset-credits';
const CONSUME_PATH = '/wham/rate-limit-reset-credits/consume';

/** Same window identities the response-header parser emits, so both sources land on one row. */
const WINDOW_FIELDS = [['primary_window', 'codex_primary'], ['secondary_window', 'codex_secondary']] as const;
const REDEEM_CODES = ['reset', 'nothing_to_reset', 'no_credit', 'already_redeemed'] as const;

export interface CodexCredentials {
  token: string;
  accountId: string;
}

/** Resolves null when no Codex (ChatGPT plan) sign-in is configured. */
export type CodexCredentialSource = () => Promise<CodexCredentials | null>;

export interface CodexAccountUsage {
  planType: string | null;
  windows: QuotaWindow[];
  /** Null when the account reported nothing about banked resets. */
  resetCredits: UsageResetCredits | null;
}

export type CodexRedeemCode = typeof REDEEM_CODES[number];

export interface CodexRedeemOutcome {
  code: CodexRedeemCode;
  windowsReset: number;
}

export interface CodexAccountClient {
  /** Null when Codex is not signed in. */
  readUsage(): Promise<CodexAccountUsage | null>;
  /** Spends one banked reset. Null when Codex is not signed in. */
  redeemReset(creditId?: string): Promise<CodexRedeemOutcome | null>;
}

export interface CodexAccountClientDeps {
  credentials: CodexCredentialSource;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  now?: () => number;
  /** Idempotency key for one redeem request. */
  requestId?: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function windowResetsAt(raw: Record<string, unknown>, nowSec: number): number | null {
  const absolute = finite(raw.reset_at);
  if (absolute !== null && absolute > 0) return absolute;
  const after = finite(raw.reset_after_seconds);
  return after === null ? null : nowSec + after;
}

function usageWindow(raw: unknown, type: string, nowSec: number): QuotaWindow | null {
  if (!isRecord(raw)) return null;
  const length = finite(raw.limit_window_seconds);
  const used = finite(raw.used_percent);
  if (length === null || length <= 0 || used === null || used < 0 || used > 100) return null;
  const resetsAt = windowResetsAt(raw, nowSec);
  return resetsAt === null ? null : { type, utilization: used / 100, resetsAt };
}

function nonNegativeCount(value: unknown): number | null {
  const count = finite(value);
  return count === null || count < 0 ? null : Math.floor(count);
}

export interface ParsedCodexUsage {
  planType: string | null;
  windows: QuotaWindow[];
  availableResets: number | null;
}

/** Parse `GET /wham/usage`. A response without any usable window is an error, never "no usage". */
export function parseCodexUsage(payload: unknown, nowMs: number): ParsedCodexUsage {
  if (!isRecord(payload)) throw new Error('Codex usage response is not an object');
  const limits = isRecord(payload.rate_limit) ? payload.rate_limit : {};
  const nowSec = Math.floor(nowMs / 1000);
  const windows = WINDOW_FIELDS.flatMap(([field, type]) => {
    const window = usageWindow(limits[field], type, nowSec);
    return window ? [window] : [];
  });
  if (windows.length === 0) throw new Error('Codex usage response has no rate-limit window');
  const summary = isRecord(payload.rate_limit_reset_credits) ? payload.rate_limit_reset_credits : {};
  return {
    planType: typeof payload.plan_type === 'string' ? payload.plan_type : null,
    windows,
    availableResets: nonNegativeCount(summary.available_count),
  };
}

function isoSeconds(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function availableCredit(raw: unknown): UsageResetCredit | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || raw.status !== 'available') return null;
  if (raw.is_supported_by_plan === false) return null;
  return { id: raw.id, title: typeof raw.title === 'string' ? raw.title : null, expiresAt: isoSeconds(raw.expires_at) };
}

function byExpiry(a: UsageResetCredit, b: UsageResetCredit): number {
  return (a.expiresAt ?? Number.POSITIVE_INFINITY) - (b.expiresAt ?? Number.POSITIVE_INFINITY);
}

/** Parse `GET /wham/rate-limit-reset-credits` into the available credits, earliest expiry first. */
export function parseResetCredits(payload: unknown): UsageResetCredits {
  if (!isRecord(payload) || !Array.isArray(payload.credits)) {
    throw new Error('Codex reset credits response has no credit list');
  }
  const credits = payload.credits.flatMap((raw) => {
    const credit = availableCredit(raw);
    return credit ? [credit] : [];
  }).sort(byExpiry);
  return { availableCount: nonNegativeCount(payload.available_count) ?? credits.length, credits };
}

export function parseRedeemOutcome(payload: unknown): CodexRedeemOutcome {
  const code = isRecord(payload) ? payload.code : undefined;
  if (!REDEEM_CODES.includes(code as CodexRedeemCode)) {
    throw new Error(`Codex reset returned an unexpected result: ${String(code)}`);
  }
  const record = payload as Record<string, unknown>;
  return { code: code as CodexRedeemCode, windowsReset: nonNegativeCount(record.windows_reset) ?? 0 };
}

function mergeResetCredits(
  listed: UsageResetCredits | null,
  summaryCount: number | null,
): UsageResetCredits | null {
  if (listed) return listed;
  return summaryCount === null ? null : { availableCount: summaryCount, credits: [] };
}

export class HttpCodexAccountClient implements CodexAccountClient {
  private readonly fetch: typeof globalThis.fetch;
  private readonly baseUrl: string;
  private readonly now: () => number;
  private readonly requestId: () => string;

  constructor(private readonly deps: CodexAccountClientDeps) {
    this.fetch = deps.fetch ?? globalThis.fetch;
    this.baseUrl = deps.baseUrl ?? CODEX_BACKEND_URL;
    this.now = deps.now ?? Date.now;
    this.requestId = deps.requestId ?? randomUUID;
  }

  async readUsage(): Promise<CodexAccountUsage | null> {
    const credentials = await this.deps.credentials();
    if (!credentials) return null;
    // The credit list only adds titles and expiry; its failure must not cost the usage reading.
    const [usage, listed] = await Promise.all([
      this.request(credentials, 'GET', USAGE_PATH),
      this.request(credentials, 'GET', CREDITS_PATH).then(parseResetCredits).catch(() => null),
    ]);
    const parsed = parseCodexUsage(usage, this.now());
    return {
      planType: parsed.planType,
      windows: parsed.windows,
      resetCredits: mergeResetCredits(listed, parsed.availableResets),
    };
  }

  async redeemReset(creditId?: string): Promise<CodexRedeemOutcome | null> {
    const credentials = await this.deps.credentials();
    if (!credentials) return null;
    const body = { redeem_request_id: this.requestId(), ...(creditId ? { credit_id: creditId } : {}) };
    return parseRedeemOutcome(await this.request(credentials, 'POST', CONSUME_PATH, body));
  }

  private async request(
    credentials: CodexCredentials,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${credentials.token}`,
      'chatgpt-account-id': credentials.accountId,
      'user-agent': 'codex-cli',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    };
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Codex ${path} HTTP ${response.status}`);
    return response.json();
  }
}

/** The daemon's Codex account, signed in through the PI runtime's stored OAuth credential. */
export const codexAccountClient: CodexAccountClient = new HttpCodexAccountClient({
  credentials: () => loadCodexCredentials(),
});
