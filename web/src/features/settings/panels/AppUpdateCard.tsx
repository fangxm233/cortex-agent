// input:  native shell update preferences, settings atoms
// output: native-shell-only quiet update controls
// pos:    App update settings with readable status metadata
// >>> Once updated, update this header and parent AGENTS.md <<<

import { useEffect, useState, type CSSProperties } from 'react';
import { isNativeShell } from '@/lib/desktop-config';
import { safeInvoke } from '@/lib/native-bridge';
import { SButton, SRow, SRowGroup, Toggle } from '@/features/settings/ui/settings-ui';

// Copy is local to this card rather than vocab: the whole section is APP-shell-only and Chinese,
// mirroring features/app-update/app-update.ts.
const MONO = "'IBM Plex Mono',monospace";

const FOOTNOTE_STYLE: CSSProperties = {
  font: `400 12px ${MONO}`, color: 'var(--proto-muted-2)', marginTop: 4, overflowWrap: 'anywhere',
};
const ALERT_STYLE: CSSProperties = {
  fontSize: 12, lineHeight: 1.5, color: 'var(--proto-danger)', marginTop: 6,
};

/**
 * Shell-side `<appDataDir>/updates/prefs.json` (desktop/src-tauri/src/update_prefs.rs) — a property
 * of THIS copy of the app, not of the server it talks to.
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
export function updateModeDescription(prefs: ShellUpdatePrefs): string {
  if (hasFallenBackToAsking(prefs)) {
    return `连续 ${prefs.failedAttempts} 次自动安装都失败了，现在每个新版本都会先询问。`
      + '点「重试自动安装」清零失败计数，下次退出时再自动装一次。';
  }
  return prefs.silent
    ? '新版本在后台下载并校验，关闭 App 时自动装好，下次打开就是新版本。'
    : '新版本下载完成后会先询问，由你决定什么时候安装。';
}

/** Mono footer: where this lives, plus the last version that actually landed. */
export function updatePrefsFootnote(prefs: ShellUpdatePrefs): string {
  const parts = ['updates/prefs.json · 本机'];
  if (prefs.lastInstalledVersion) parts.push(`上次更新到 ${prefs.lastInstalledVersion}`);
  return parts.join(' · ');
}

export function AppUpdateCard() {
  const [prefs, setPrefs] = useState<ShellUpdatePrefs | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const native = isNativeShell();

  useEffect(() => {
    if (!native) return;
    let alive = true;
    void safeInvoke('get_update_prefs').then((result) => {
      // A shell that predates silent updating has no such command; the card just stays hidden.
      if (alive && result.ok) setPrefs(parseShellUpdatePrefs(result.value));
    });
    return () => { alive = false; };
  }, [native]);

  if (!native || !prefs) return null;

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

  const fallenBack = hasFallenBackToAsking(prefs);
  return (
    <SRowGroup data-app-update-silent="">
      <SRow
        title="自动安装更新"
        desc={
          <span style={{ color: fallenBack ? 'var(--proto-danger)' : undefined }}>
            {updateModeDescription(prefs)}
          </span>
        }
        control={
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            {fallenBack ? (
              <SButton tone="neutral" disabled={pending} data-app-update-retry=""
                onClick={() => void write(true)}>重试自动安装</SButton>
            ) : null}
            <Toggle on={prefs.silent} inert={pending} ariaLabel="自动安装更新"
              onClick={pending ? undefined : () => void write(!prefs.silent)} />
          </div>
        }
      >
        {failed ? (
          <div role="alert" style={ALERT_STYLE}>没能保存更新设置，请再试一次。</div>
        ) : null}
        <div style={FOOTNOTE_STYLE}>{updatePrefsFootnote(prefs)}</div>
      </SRow>
    </SRowGroup>
  );
}
