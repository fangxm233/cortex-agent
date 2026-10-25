import { safeInvoke } from '@/lib/native-bridge';

// The shell reports setup steps itself, before any server exists; only the environment silences
// them. The user's choice comes after install, on the first setup page, as the server's setting.

/** The `telemetry` field of the init answers: the new server adopts the shell's install id. */
export const NEW_SERVER_TELEMETRY = { enabled: true } as const;

/** Tell the shell the setup screen's language, so the steps of the install carry it. */
export function recordSetupLang(lang: string): void {
  void safeInvoke('setup_telemetry_lang', { lang });
}
