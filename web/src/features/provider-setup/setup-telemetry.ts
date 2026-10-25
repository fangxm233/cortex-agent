import { safeInvoke } from '@/lib/native-bridge';

// The setup opt-in, shared by the choose screen and the repair form of one onboarding page. The
// shell keeps its own copy (it reports setup steps before any server exists), so every change and
// the start of an install tell it; init then receives the choice through the answers.

let enabled = true;
const listeners = new Set<() => void>();

export const setupTelemetry = {
  enabled: (): boolean => enabled,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  set(next: boolean, lang: string): void {
    enabled = next;
    listeners.forEach((listener) => listener());
    setupTelemetry.sync(lang);
  },
  /** Hand the shell the current choice and the setup screen's language. */
  sync(lang: string): void {
    void safeInvoke('setup_telemetry_consent', { enabled, lang });
  },
};

/** The `telemetry` field of the init answers. */
export function telemetryAnswer(): { enabled: boolean } {
  return { enabled };
}
