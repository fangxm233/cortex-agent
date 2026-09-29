import type { ConfigSnapshot } from '@cortex-agent/ui-contract';

export interface MSettingsVm {
  profileName: string | null;
  profileModel: string | null;
  profileThinking: string | null;
}

export function buildMSettingsVm(snapshot: ConfigSnapshot): MSettingsVm {
  const profiles = snapshot.profiles;
  const defaultName = profiles?.defaultProfile ?? null;
  const defaultEntry = defaultName
    ? profiles?.profiles.find((profile) => profile.name === defaultName) ?? null
    : null;
  return {
    profileName: defaultName,
    profileModel: defaultEntry?.model ?? null,
    profileThinking: defaultEntry?.thinking ?? null,
  };
}
