import type { ConfigSnapshot } from '@cortex-agent/ui-contract';
import { modelLabel } from '@/lib/model-selection';

export interface MSettingsVm {
  modelLabel: string | null;
  thinking: string | null;
}

export function buildMSettingsVm(snapshot: ConfigSnapshot): MSettingsVm {
  const selection = snapshot.models.default;
  return {
    modelLabel: selection ? modelLabel(selection) : null,
    thinking: selection?.thinking ?? null,
  };
}
