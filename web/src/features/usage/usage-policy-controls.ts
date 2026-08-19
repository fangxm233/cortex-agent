// input:  provider policy views, control readiness, and local threshold draft text
// output: synced threshold draft text plus save/reset disabled state
// pos:    Shared desktop/mobile policy-control helpers
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { useEffect, useState } from 'react';
import type { ProviderRateLimitView } from './usage-vm';

export interface UsagePolicyActionState {
  disabled: boolean;
  saveDisabled: boolean;
  resetDisabled: boolean;
}

export interface UsagePolicyDraftState {
  draft: string;
  parsedThreshold: number | null;
  setDraft: (value: string) => void;
}

export function formatThresholdDraft(value: number | null): string {
  return value === null ? '' : `${value}`;
}

export function parseThresholdDraft(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) return null;
  return Math.round(parsed * 100) / 100;
}

export function policyActionState(
  controlsDisabled: boolean,
  pending: boolean,
  parsedThreshold: number | null,
  customThresholdPercent: number | null,
): UsagePolicyActionState {
  const disabled = controlsDisabled || pending;
  return {
    disabled,
    saveDisabled: disabled || parsedThreshold === null || parsedThreshold === customThresholdPercent,
    resetDisabled: disabled || customThresholdPercent === null,
  };
}

export function usePolicyThresholdDraft(policy: ProviderRateLimitView | null): UsagePolicyDraftState {
  const [draft, setDraft] = useState(formatThresholdDraft(policy?.customThresholdPercent ?? null));

  useEffect(() => {
    setDraft(formatThresholdDraft(policy?.customThresholdPercent ?? null));
  }, [policy?.customThresholdPercent]);

  return { draft, parsedThreshold: parseThresholdDraft(draft), setDraft };
}
