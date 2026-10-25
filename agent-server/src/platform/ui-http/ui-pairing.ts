// One-time pairing codes: the short credential a new app or browser types instead of the 64-char
// client token. A signed-in UI (or `cortex ui pair` on the server) mints a code; redeeming it once
// hands the newcomer its own device token (apps) or a session cookie (browsers).
//
// Codes live in a file rather than in memory because the CLI that mints one runs in a different
// process from the server that redeems it. Every operation re-reads the file for the same reason.

import * as crypto from 'crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import * as path from 'path';
import { createLogger } from '@core/log.js';

const log = createLogger('ui-http');

/** Outstanding codes, under the store dir — shared by the server and `cortex ui pair`. */
export const PAIRING_FILE_NAME = 'ui-pairing.json';

/** How long a code stays redeemable. */
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

/**
 * Wrong guesses tolerated before every outstanding code is voided. With 40 bits per code this caps
 * an online guesser's odds at roughly 20 in 10^12 per minted code.
 */
export const PAIRING_MAX_FAILURES = 20;

/** Crockford base32: no I, L, O or U, so a code read aloud or off a phone screen survives. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;
/** Look-alikes a person may type for a digit. */
const LOOKALIKES: Record<string, string> = { O: '0', I: '1', L: '1' };

export interface PairingCode {
  /** Display form, `XXXX-XXXX`. */
  code: string;
  expiresAt: number;
}

export interface PairingStore {
  create(): PairingCode;
  /** Consume a live code. True at most once per code; every miss counts toward the failure cap. */
  redeem(input: string): boolean;
}

interface Persisted {
  /** Normalized code → epoch-ms expiry. */
  codes: Record<string, number>;
  /** Failed redemptions since the last code was minted. */
  failures: number;
}

/** Canonical form of a typed code, or null when the input cannot be a pairing code at all. */
export function normalizePairingCode(input: string): string | null {
  const raw = input.toUpperCase().replace(/[\s-]/g, '');
  if (raw.length !== CODE_LENGTH) return null;
  const mapped = [...raw].map((ch) => LOOKALIKES[ch] ?? ch).join('');
  return [...mapped].every((ch) => ALPHABET.includes(ch)) ? mapped : null;
}

function formatCode(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

function randomCode(): string {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}

function readState(file: string, now: number): Persisted {
  let parsed: Partial<Persisted> | null = null;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Persisted>;
  } catch {
    // absent or corrupt → no codes
  }
  const codes: Record<string, number> = {};
  for (const [code, exp] of Object.entries(parsed?.codes ?? {})) {
    if (typeof exp === 'number' && exp > now) codes[code] = exp;
  }
  return { codes, failures: typeof parsed?.failures === 'number' ? parsed.failures : 0 };
}

function writeState(file: string, state: Persisted): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    log.warn(`could not persist pairing codes: ${(e as Error).message}`);
  }
}

export function createPairingStore(opts: { file: string; now?: () => number }): PairingStore {
  const now = opts.now ?? (() => Date.now());
  const { file } = opts;

  return {
    create(): PairingCode {
      const t = now();
      const state = readState(file, t);
      const raw = randomCode();
      state.codes[raw] = t + PAIRING_CODE_TTL_MS;
      state.failures = 0;
      writeState(file, state);
      return { code: formatCode(raw), expiresAt: state.codes[raw] };
    },

    redeem(input: string): boolean {
      const state = readState(file, now());
      const raw = normalizePairingCode(input);
      if (raw && raw in state.codes) {
        delete state.codes[raw];
        writeState(file, state);
        return true;
      }
      state.failures += 1;
      if (state.failures >= PAIRING_MAX_FAILURES) {
        log.warn('too many wrong pairing codes — voiding every outstanding code');
        state.codes = {};
        state.failures = 0;
      }
      writeState(file, state);
      return false;
    },
  };
}
