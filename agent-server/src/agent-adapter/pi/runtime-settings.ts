import type { PiSdkModule } from '@core/pi-sdk.js';
import { getSettings } from '@core/settings.js';

type PiSettingsManager = ReturnType<PiSdkModule['SettingsManager']['create']>;

function projectTrusted(sdk: PiSdkModule, cwd: string, agentDir: string): boolean {
  // Match Pi's non-interactive trust default for projects without dynamic resources.
  if (!sdk.hasTrustRequiringProjectResources(cwd)) return true;
  return new sdk.ProjectTrustStore(agentDir).get(cwd) === true;
}

/**
 * The reserve that makes PI compact against `min(contextWindow, cap)`. PI compacts once the context
 * passes `contextWindow - reserve`, so widening the reserve by the window's excess over the cap
 * moves that point to `cap - reserve`. Half the cap bounds the reserve: a reserve at or above the
 * capped window would compact on every turn.
 */
export function cappedReserveTokens(reserve: number, contextWindow: number | undefined, cap: number | null): number {
  if (cap === null || !contextWindow || contextWindow <= cap) return reserve;
  return contextWindow - cap + Math.min(reserve, Math.floor(cap / 2));
}

/**
 * Apply Cortex's `maxContextTokens` through the reserve rather than the model's window: PI
 * re-reads the model from its registry when providers change and also judges overflow against that
 * window. PI passes its full model object here, so the window is read off it. The cap is read on
 * every call, so a changed setting reaches sessions already running.
 */
function capCompactionReserve(settingsManager: PiSettingsManager): void {
  const nativeReserve = settingsManager.getCompactionReserveTokens.bind(settingsManager);
  settingsManager.getCompactionReserveTokens = (model) => cappedReserveTokens(
    nativeReserve(model),
    (model as { contextWindow?: number } | undefined)?.contextWindow,
    getSettings().maxContextTokens,
  );
}

export function createRuntimeSettings(sdk: PiSdkModule, cwd: string, agentDir: string) {
  const settingsManager = sdk.SettingsManager.create(cwd, agentDir, {
    projectTrusted: projectTrusted(sdk, cwd, agentDir),
  });
  // Cortex does not account for warming usage yet. Preserve pre-upgrade behavior.
  // Pi 0.87 reads this getter from globalSettings, ignoring applyOverrides(), while
  // setCacheWarmingMode() persists to disk. Override only this runtime instance;
  // the policy also survives settings reloads without changing user configuration.
  settingsManager.getCacheWarmingMode = () => 'off';
  capCompactionReserve(settingsManager);
  return settingsManager;
}
