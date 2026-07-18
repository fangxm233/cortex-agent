import { updateSummaryLine, type StagedUpdate } from '@/features/hot-update/frontend-update';

// Mobile hot-update prompt — 1:1 rebuild of scheme-mobile.dc.html §3a (热更新弹窗). A centered alert
// over the session list (overlay ink 44%): 46px run-blue icon square + title「新版本已就绪」+ Plex Mono
// version line + reassurance copy + full-width ink「退出 App」primary (48px) + plain-text「忽略」secondary
// (44px). Raw px/hex by mobile convention (§8.3 @ds-adherence-ignore — the mobile palette is not in the
// light proto token set). Presentational — the provider owns staged + apply/dismiss.
//
// 「退出 App」: on Android the app exits and the system relaunches it, applying the staged update
// (design 3a). Overlay tap is intentionally NOT a dismiss (touch mis-tap guard); 忽略 is the explicit out.

const MONO = "'IBM Plex Mono', monospace";

export interface MHotUpdateDialogProps {
  update: StagedUpdate;
  onApply: () => void;
  onDismiss: () => void;
}

export function MHotUpdateDialog({ update, onApply, onDismiss }: MHotUpdateDialogProps) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="新版本已就绪"
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
          新版本已就绪
        </div>
        <div style={{ font: `500 10.5px ${MONO}`, color: 'var(--proto-muted-3)', marginTop: 6 }}>
          {updateSummaryLine(update)}
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
          热更新已在后台下载完成，重启 App 后生效。运行中的线程在服务端继续执行，不受重启影响。
        </div>

        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <button
            type="button"
            onClick={onApply}
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
            }}
          >
            退出 App
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
              width: '100%',
            }}
          >
            忽略
          </button>
        </div>
      </div>
    </div>
  );
}
