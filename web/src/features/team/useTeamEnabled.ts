import { useServerSetting } from '@/lib/useServerSetting';

/**
 * The experimental team-mode switch (`settings.teamEnabled`, on by default). Read from the shared
 * `config.get` snapshot. Fail-closed: reports `false` while loading or when the server omits it.
 */
export function useTeamEnabled(): boolean {
  return useServerSetting('teamEnabled') === true;
}
