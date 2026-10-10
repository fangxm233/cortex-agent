import type { UsageResetCredits } from './usage-store.js';

/** Providers whose subscription accounts hold banked usage-limit resets Cortex can spend. */
export const RESET_PROVIDERS = ['openai-codex', 'anthropic'] as const;
export type ResetProvider = typeof RESET_PROVIDERS[number];

export function isResetProvider(provider: string): provider is ResetProvider {
  return (RESET_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * Outcome of one redeem request, normalized across providers. `signed_out`: no account sign-in, so
 * nothing was attempted. Every status other than `reset` means no reset was spent.
 */
export type ResetStatus =
  | 'reset' | 'nothing_to_reset' | 'no_credit' | 'already_redeemed' | 'cooldown' | 'ineligible' | 'signed_out';

/** One account quota window: utilization is a fraction in [0,1]; an idle window may have no reset
 *  time yet. */
export interface AccountWindow {
  type: string;
  utilization: number;
  /** Epoch seconds. */
  resetsAt: number | null;
}

/** What an account reports about its quota windows and banked resets. */
export interface AccountReading {
  windows: AccountWindow[];
  /** Null when the account reported nothing about banked resets. */
  resetCredits: UsageResetCredits | null;
}

export interface AccountRedeemOutcome {
  status: Exclude<ResetStatus, 'signed_out'>;
  /** Window types the reset cleared; empty when the provider does not say. */
  cleared: string[];
}

/** One provider account that can be read and can spend a banked reset. Null: not signed in. */
export interface ResetAccount {
  readUsage(): Promise<AccountReading | null>;
  redeemReset(creditId?: string): Promise<AccountRedeemOutcome | null>;
}
