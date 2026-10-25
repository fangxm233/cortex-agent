import { useVocab, type Vocab } from '@/i18n';
import { useEffect, useState, type CSSProperties } from 'react';
import { isNativeShell } from '@/lib/desktop-config';
import { safeInvoke } from '@/lib/native-bridge';
import { SButton, SRow, Toggle } from '@/features/settings/ui/settings-ui';

const FOOTNOTE_STYLE: CSSProperties = {
  fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'var(--proto-muted-2)', marginTop: 4, overflowWrap: 'anywhere',
};
const ALERT_STYLE: CSSProperties = {
  fontSize: 12, lineHeight: 1.5, color: 'var(--proto-danger)', marginTop: 6,
};

/**
 * Shell-side update preferences (desktop/src-tauri/src/update_prefs.rs) — a property of THIS copy
 * of the app, not of the server it talks to.
 */
export interface ShellUpdatePrefs {
  /** The user-facing switch. Default true: updates install themselves on quit. */
  silent: boolean;
  /** Consecutive failed quiet installs; reset by a success or by switching silent back on. */
  failedAttempts: number;
  /** Version of the last update that landed, absent before the first one. */
  lastInstalledVersion?: string;
}

/** install_site.rs MAX_SILENT_FAILURES — at this many failures in a row the shell asks instead. */
const MAX_SILENT_FAILURES = 3;

/** Coerce a command result into prefs, or null if it is not shaped like one (older shell). */
export function parseShellUpdatePrefs(value: unknown): ShellUpdatePrefs | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as Record<string, unknown>;
  if (typeof p.silent !== 'boolean') return null;
  const prefs: ShellUpdatePrefs = {
    silent: p.silent,
    failedAttempts: typeof p.failedAttempts === 'number' && p.failedAttempts > 0 ? p.failedAttempts : 0,
  };
  if (typeof p.lastInstalledVersion === 'string' && p.lastInstalledVersion) {
    prefs.lastInstalledVersion = p.lastInstalledVersion;
  }
  return prefs;
}

/** The switch is on, but the shell has given up on quiet installs and is asking every time. */
export function hasFallenBackToAsking(prefs: ShellUpdatePrefs): boolean {
  return prefs.silent && prefs.failedAttempts >= MAX_SILENT_FAILURES;
}

/** What the app will actually do with the next version — never what the switch merely claims. */
export function updateModeDescription(prefs: ShellUpdatePrefs, L: Vocab): string {
  if (hasFallenBackToAsking(prefs)) {
    return L.updateAutoFailed;
  }
  return prefs.silent
    ? L.updateAutoHint
    : L.updateAskHint;
}

/** Mono footer: this is a local app setting, plus the last version that actually landed. */
export function updatePrefsFootnote(prefs: ShellUpdatePrefs, L: Vocab): string {
  const parts = [L.updateLocalSetting];
  if (prefs.lastInstalledVersion) parts.push(L.updateLastInstalled.replace('{version}', prefs.lastInstalledVersion));
  return parts.join(' · ');
}

export interface AppUpdateController {
  /** Null off the native shell, until the shell answers, and on shells without the commands. */
  prefs: ShellUpdatePrefs | null;
  pending: boolean;
  failed: boolean;
  write: (silent: boolean) => void;
}

export function useAppUpdateController(): AppUpdateController {
  const [prefs, setPrefs] = useState<ShellUpdatePrefs | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const native = isNativeShell();

  useEffect(() => {
    if (!native) return;
    let alive = true;
    void safeInvoke('get_update_prefs').then((result) => {
      // A shell that predates silent updating has no such command; the row just stays hidden.
      if (alive && result.ok) setPrefs(parseShellUpdatePrefs(result.value));
    });
    return () => { alive = false; };
  }, [native]);

  // The shell answers with the stored prefs, so the switch follows what was persisted rather than
  // what was clicked — that is also how turning silent back on clears the failure counter.
  const write = async (silent: boolean) => {
    setPending(true);
    setFailed(false);
    const result = await safeInvoke('set_update_silent', { silent });
    const next = result.ok ? parseShellUpdatePrefs(result.value) : null;
    if (next) setPrefs(next);
    else setFailed(true);
    setPending(false);
  };
  return { prefs: native ? prefs : null, pending, failed, write: (silent) => void write(silent) };
}

function AppUpdateControl({ controller, prefs }: { controller: AppUpdateController; prefs: ShellUpdatePrefs }) {
  const L = useVocab();
  const { pending, write } = controller;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
      {hasFallenBackToAsking(prefs) ? (
        <SButton tone="neutral" disabled={pending} data-app-update-retry=""
          onClick={() => write(true)}>{L.updateRetryAutomatic}</SButton>
      ) : null}
      <Toggle on={prefs.silent} inert={pending} ariaLabel={L.updateAutomatic}
        onClick={pending ? undefined : () => write(!prefs.silent)} />
    </div>
  );
}

/** This copy of the app's own update switch; hidden wherever the controller has no prefs. */
export function AppUpdateRow({ controller }: { controller: AppUpdateController }) {
  const L = useVocab();
  const { prefs } = controller;
  if (!prefs) return null;
  return (
    <SRow
      data-app-update-silent=""
      title={L.updateAutomatic}
      desc={
        <span style={{ color: hasFallenBackToAsking(prefs) ? 'var(--proto-danger)' : undefined }}>
          {updateModeDescription(prefs, L)}
        </span>
      }
      control={<AppUpdateControl controller={controller} prefs={prefs} />}
    >
      {controller.failed ? (
        <div role="alert" style={ALERT_STYLE}>{L.updatePrefsFailed}</div>
      ) : null}
      <div style={FOOTNOTE_STYLE}>{updatePrefsFootnote(prefs, L)}</div>
    </SRow>
  );
}
