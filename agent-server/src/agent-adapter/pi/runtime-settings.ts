// input:  Pi SDK, working directory, agent directory
// output: createRuntimeSettings
// pos:    Apply Cortex settings policy to main and child sessions
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import type { PiSdkModule } from '@core/pi-sdk.js';

function projectTrusted(sdk: PiSdkModule, cwd: string, agentDir: string): boolean {
  // Match Pi's non-interactive trust default for projects without dynamic resources.
  if (!sdk.hasTrustRequiringProjectResources(cwd)) return true;
  return new sdk.ProjectTrustStore(agentDir).get(cwd) === true;
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
  return settingsManager;
}
