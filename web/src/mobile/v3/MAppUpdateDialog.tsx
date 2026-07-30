import {
  appUpdateSummaryLine,
  installCtaLabel,
  installDescription,
  type AppUpdateInfo,
} from '@/features/app-update/app-update';

// Mobile app shell update prompt — same alert grammar as MHotUpdateDialog (3a), with per-kind CTA +
// copy (on Android: kind=apk → the system package installer is raised over the verified APK). Raw
// px/hex by mobile convention (§8.3 @ds-adherence-ignore). Overlay tap is intentionally NOT a
// dismiss (touch mis-tap guard); 稍后 / 跳过此版本 are the explicit outs. Presentational — the
// provider owns state and actions.

const MONO = "'IBM Plex Mono', monospace";

export interface MAppUpdateDialogProps {
  update: AppUpdateInfo;
  busy: boolean;
  error: string | null;
  onInstall: () => void;
  onSkip: () => void;
  onDismiss: () => void;
}

export function MAppUpdateDialog({
  update, busy, error, onInstall, onSkip, onDismiss,
}: MAppUpdateDialogProps) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="App 新版本已就绪"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: 'rgba(25,28,34,.44)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 36px',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          width: '100%',
          background: 'var(--proto-card)',
          borderRadius: 18,
          boxShadow: '0 24px 64px rgba(16,24,40,.32)',
          padding: '24px 20px 14px',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
        }}
      >
        <div
          style={{
            width: 46,
            height: 46,
            borderRadius: 14,
            background: 'var(--proto-accent-bg)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 14,
          }}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="var(--proto-accent)" strokeWidth="1.8">
            <path d="M10 14V4M5.5 8.5 10 4l4.5 4.5" />
            <path d="M3.5 16.5h13" />
          </svg>
        </div>

        <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--proto-ink)', letterSpacing: '-.01em' }}>
          App 新版本已就绪
        </div>
        <div style={{ font: `500 10.5px ${MONO}`, color: 'var(--proto-muted-3)', marginTop: 6 }}>
          {appUpdateSummaryLine(update)}
        </div>
        <div
          style={{
            fontSize: 13,
            lineHeight: 1.6,
            color: 'var(--proto-muted)',
            textAlign: 'center',
            margin: '10px 0 18px',
          }}
        >
          {installDescription(update.kind)}
        </div>
        {error ? (
          <div style={{ fontSize: 12, color: 'var(--proto-danger, #d92d20)', marginBottom: 10, textAlign: 'center' }}>
            安装失败：{error}
          </div>
        ) : null}

        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <button
            type="button"
            onClick={onInstall}
            disabled={busy}
            style={{
              height: 48,
              border: 'none',
              borderRadius: 13,
              background: 'var(--proto-ink)',
              color: 'var(--ink-solid-fg)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 14.5,
              fontWeight: 600,
              cursor: 'pointer',
              width: '100%',
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? '正在处理…' : installCtaLabel(update.kind)}
          </button>
          <div style={{ display: 'flex', width: '100%' }}>
            <button
              type="button"
              onClick={onSkip}
              style={{
                height: 44,
                border: 'none',
                background: 'transparent',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 13.5,
                fontWeight: 600,
                color: 'var(--proto-muted-2)',
                cursor: 'pointer',
                flex: 1,
              }}
            >
              跳过此版本
            </button>
            <button
              type="button"
              onClick={onDismiss}
              style={{
                height: 44,
                border: 'none',
                background: 'transparent',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 13.5,
                fontWeight: 600,
                color: 'var(--proto-muted-2)',
                cursor: 'pointer',
                flex: 1,
              }}
            >
              稍后
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
