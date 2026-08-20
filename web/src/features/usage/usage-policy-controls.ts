// input:  row policy views, control readiness, and local threshold draft text
// output: synced threshold draft text plus per-row save/reset disabled state
// pos:    Shared desktop/mobile row-policy helpers
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { useEffect, useState } from 'react';
import type { UsageWindowPolicyView } from './usage-vm';

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

function isSystemDefault(policy: UsageWindowPolicyView | null): boolean {
  if (!policy) return true;
  return policy.enabled && policy.thresholdPercent === policy.defaultThresholdPercent && !policy.usesLegacyFallback;
}

export function policyActionState(
  controlsDisabled: boolean,
  pending: boolean,
  parsedThreshold: number | null,
  policy: UsageWindowPolicyView | null,
): UsagePolicyActionState {
  const disabled = controlsDisabled || pending || !policy;
  return {
    disabled,
    saveDisabled: disabled || parsedThreshold === null || parsedThreshold === policy?.thresholdPercent,
    resetDisabled: disabled || isSystemDefault(policy),
  };
}

export function usePolicyThresholdDraft(policy: UsageWindowPolicyView | null): UsagePolicyDraftState {
  const [draft, setDraft] = useState(formatThresholdDraft(policy?.thresholdPercent ?? null));

  useEffect(() => {
    setDraft(formatThresholdDraft(policy?.thresholdPercent ?? null));
  }, [policy?.thresholdPercent]);

  return { draft, parsedThreshold: parseThresholdDraft(draft), setDraft };
}
