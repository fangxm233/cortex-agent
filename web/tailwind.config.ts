import type { Config } from 'tailwindcss';

// Single source of truth for the Cortex UI design tokens (design §5, v2 定稿).
// No screen may hard-code a hex value — every color/space/radius/shadow/font below
// is consumed as a Tailwind token. Status pills and mono text are built from `pill`
// and `fontFamily.mono` respectively.
const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // State palette
        state: {
          ink: '#191C22',
          run: '#4655D4',
          wait: '#A96B0B',
          done: '#23854F',
          fail: '#C03D33',
          gray: '#F1F2F5',
        },
        // Status-pill tinted bg/fg pairs
        pill: {
          'running-bg': '#EEF0FA',
          'running-fg': '#4655D4',
          'waiting-bg': '#F7ECCE',
          'waiting-fg': '#8A5B06',
          'done-bg': '#E9F4EE',
          'done-fg': '#23854F',
          'failed-bg': '#FBEDEB',
          'failed-fg': '#C03D33',
          'cancelled-bg': '#F1F2F5',
          'cancelled-fg': '#8A93A2',
        },
        // Surfaces
        surface: {
          card: '#FFFFFF',
          canvas: '#E9E7E2', // prototype html/body base (was #F0EEE9; realigned §8.6 RA)
          'canvas-alt': '#F7F8FA',
          rail: '#FBFBFC',
        },
        // Prototype 1:1 palette (design §8.6 RA / task 6d21). Audited from
        // prototype.dc.html — the recurring structural ink/line/accent/amber
        // scale. Per §8.3 one-off hexes may stay raw in a screen; these are the
        // values that repeat across the design and become tokens for RB+.
        proto: {
          base: '#E9E7E2',
          card: '#FFFFFF',
          rail: '#FBFBFC',
          alt: '#F7F8FA',
          gray: '#F1F2F5',
          // ink / text scale (darkest → faint)
          ink: '#191C22',
          'ink-2': '#22262E',
          'ink-3': '#383E48',
          muted: '#5B6472',
          'muted-2': '#8A93A2',
          'muted-3': '#98A1B0',
          faint: '#B6BDC9',
          // hairlines / borders
          line: '#E7E9EE',
          'line-2': '#EFF1F5',
          'line-3': '#D9DCE3',
          'line-4': '#E3E6F0',
          // accent (run / blue)
          accent: '#4655D4',
          'accent-bg': '#EEF0FA',
          'accent-border': '#C9CFF2',
          'accent-2': '#9AA3E8',
          'accent-strong': '#3A48B8',
          // amber (waiting / approvals)
          amber: '#C99A2E',
          'amber-fg': '#8A5B06',
          'amber-bg': '#FDF9F0',
          'amber-border': '#EFDDB0',
          'amber-accent': '#C0A96E',
          // success (done)
          success: '#23854F',
          'success-bg': '#E9F4EE',
          // danger (failed)
          danger: '#C03D33',
          'danger-bg': '#FBEDEB',
        },
      },
      borderColor: {
        card: 'rgba(0,0,0,0.08)',
      },
      // Fonts match the prototype exactly (§8.6 RA). Sans = prototype html/body
      // stack; mono = IBM Plex Mono (loaded via Google Fonts in index.html).
      fontFamily: {
        sans: [
          '-apple-system',
          '"Segoe UI"',
          '"Helvetica Neue"',
          'Helvetica',
          'Arial',
          '"PingFang SC"',
          '"Hiragino Sans GB"',
          '"Microsoft YaHei"',
          'sans-serif',
        ],
        mono: ['"IBM Plex Mono"', 'monospace'],
      },
      fontSize: {
        ui: ['13px', { lineHeight: '1.4' }],
        body: ['14px', { lineHeight: '1.5' }],
      },
      // 8px grid
      spacing: {
        grid: '8px',
        '0.5g': '4px',
        '1g': '8px',
        '1.5g': '12px',
        '2g': '16px',
        '3g': '24px',
        '4g': '32px',
        '5g': '40px',
        '6g': '48px',
      },
      borderRadius: {
        card: '10px',
      },
      boxShadow: {
        card: '0 1px 2px rgba(0,0,0,0.04), 0 1px 3px rgba(0,0,0,0.06)',
        overlay: '0 10px 38px rgba(0,0,0,0.20), 0 6px 12px rgba(0,0,0,0.12)',
        // Hot-update modal (design 21a): heavier drop shadow than the generic overlay. Verbatim from
        // scheme.dc.html #21a modal (`0 24px 64px rgba(16,24,40,.32)`).
        'overlay-strong': '0 24px 64px rgba(16,24,40,0.32)',
        // Notification toast (design 18a): 二级投影 — lighter than modal, heavier than card. Verbatim
        // from scheme.dc.html #18a bubble shadow.
        toast: '0 8px 28px rgba(16,24,40,0.13), 0 2px 6px rgba(16,24,40,0.05)',
        // The collapsed "+N" overflow pill (design 18a) — a lighter one-level shadow.
        'toast-pill': '0 4px 14px rgba(16,24,40,0.10)',
      },
      // Overlay enter/exit motion (design §5, task 970d). Driven off Radix
      // `data-[state=open|closed]` attributes; kept token-side (no extra dep).
      // `motion-reduce:` variants in the primitives disable transforms.
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'fade-out': { from: { opacity: '1' }, to: { opacity: '0' } },
        'zoom-in': {
          from: { opacity: '0', transform: 'translate(-50%, -48%) scale(0.96)' },
          to: { opacity: '1', transform: 'translate(-50%, -50%) scale(1)' },
        },
        'zoom-out': {
          from: { opacity: '1', transform: 'translate(-50%, -50%) scale(1)' },
          to: { opacity: '0', transform: 'translate(-50%, -48%) scale(0.96)' },
        },
        'slide-in-right': { from: { transform: 'translateX(100%)' }, to: { transform: 'translateX(0)' } },
        'slide-out-right': { from: { transform: 'translateX(0)' }, to: { transform: 'translateX(100%)' } },
        'slide-in-left': { from: { transform: 'translateX(-100%)' }, to: { transform: 'translateX(0)' } },
        'slide-out-left': { from: { transform: 'translateX(0)' }, to: { transform: 'translateX(-100%)' } },
        'toast-in': {
          from: { opacity: '0', transform: 'translateX(calc(100% + 16px))' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        'toast-out': {
          from: { opacity: '1', transform: 'translateX(0)' },
          to: { opacity: '0', transform: 'translateX(calc(100% + 16px))' },
        },
        // Notification auto-dismiss progress line (design 18a: 底部 2px 进度线 = 自动消失倒计时).
        // Shrinks the 2px bar left-to-right over the dwell; onAnimationEnd fires the dismiss so
        // the visual countdown and the removal stay in perfect sync, and `paused` on hover pauses
        // both at once (scheme 18a: hover 暂停倒计时).
        toastbar: { from: { width: '100%' }, to: { width: '0%' } },
        'popover-in': {
          from: { opacity: '0', transform: 'scale(0.96)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        'popover-out': {
          from: { opacity: '1', transform: 'scale(1)' },
          to: { opacity: '0', transform: 'scale(0.96)' },
        },
        // Prototype 1:1 animation set (§8.6 RA / task 6d21). Verbatim from the
        // prototype `<style>` — also present as raw `@keyframes cx*` in index.css
        // (the inline `animation:cx…` shorthand in the design depends on those
        // global names); mirrored here for `animate-cx*` utility parity in RB.
        cxblink: { '0%,55%': { opacity: '1' }, '56%,100%': { opacity: '0' } },
        cxpulse: { '0%,100%': { opacity: '1' }, '50%': { opacity: '0.3' } },
        cxtoast: {
          from: { opacity: '0', transform: 'translate(-50%,10px)' },
          to: { opacity: '1', transform: 'translate(-50%,0)' },
        },
        cxfade: { from: { opacity: '0' }, to: { opacity: '1' } },
        cxmodal: {
          from: { opacity: '0', transform: 'translate(-50%,-46%) scale(0.975)' },
          to: { opacity: '1', transform: 'translate(-50%,-50%) scale(1)' },
        },
        cxcmdk: {
          from: { opacity: '0', transform: 'translate(-50%,-12px) scale(0.98)' },
          to: { opacity: '1', transform: 'translate(-50%,0) scale(1)' },
        },
        cxpop: {
          from: { opacity: '0', transform: 'translateY(-6px) scale(0.97)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        cxpopup: {
          from: { opacity: '0', transform: 'translateY(8px) scale(0.97)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        cxpopover: {
          from: { opacity: '0', transform: 'translateY(-10px) scale(0.97)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        cxdrawer: { from: { transform: 'translateX(100%)' }, to: { transform: 'translateX(0)' } },
        cxmodalout: {
          from: { opacity: '1', transform: 'translate(-50%,-50%) scale(1)' },
          to: { opacity: '0', transform: 'translate(-50%,-48%) scale(0.975)' },
        },
        cxcmdkout: {
          from: { opacity: '1', transform: 'translate(-50%,0) scale(1)' },
          to: { opacity: '0', transform: 'translate(-50%,-12px) scale(0.98)' },
        },
        cxdrawerout: { from: { transform: 'translateX(0)' }, to: { transform: 'translateX(100%)' } },
        cxfadeout: { from: { opacity: '1' }, to: { opacity: '0' } },
        cxmsg: {
          from: { opacity: '0', transform: 'translateY(12px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        cxrise: {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 150ms ease-out',
        'fade-out': 'fade-out 120ms ease-in',
        'zoom-in': 'zoom-in 160ms cubic-bezier(0.16, 1, 0.3, 1)',
        'zoom-out': 'zoom-out 120ms ease-in',
        'slide-in-right': 'slide-in-right 200ms cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-out-right': 'slide-out-right 160ms ease-in',
        'slide-in-left': 'slide-in-left 200ms cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-out-left': 'slide-out-left 160ms ease-in',
        'toast-in': 'toast-in 180ms cubic-bezier(0.16, 1, 0.3, 1)',
        'toast-out': 'toast-out 120ms ease-in',
        // 6s dwell (design 18a: info 6s 自动消失). Duration matches AUTO_DISMISS_MS in
        // features/notifications/notification-vm.ts.
        toastbar: 'toastbar 6000ms linear forwards',
        'popover-in': 'popover-in 140ms cubic-bezier(0.16, 1, 0.3, 1)',
        'popover-out': 'popover-out 100ms ease-in',
        // Prototype animation defaults (durations/easings as used in the source).
        cxblink: 'cxblink 1.1s steps(1) infinite',
        cxpulse: 'cxpulse 1.6s ease-in-out infinite',
        cxtoast: 'cxtoast 0.18s ease-out',
        cxfade: 'cxfade 0.18s ease-out',
        cxmodal: 'cxmodal 0.2s cubic-bezier(0.22, 1, 0.36, 1)',
        cxcmdk: 'cxcmdk 0.18s cubic-bezier(0.22, 1, 0.36, 1)',
        cxpop: 'cxpop 0.16s cubic-bezier(0.22, 1, 0.36, 1)',
        cxpopup: 'cxpopup 0.18s cubic-bezier(0.22, 1, 0.36, 1)',
        cxpopover: 'cxpopover 0.16s cubic-bezier(0.22, 1, 0.36, 1)',
        cxdrawer: 'cxdrawer 0.24s cubic-bezier(0.22, 1, 0.36, 1)',
        cxmodalout: 'cxmodalout 0.14s ease-in',
        cxcmdkout: 'cxcmdkout 0.14s ease-in',
        cxdrawerout: 'cxdrawerout 0.2s ease-in',
        cxfadeout: 'cxfadeout 0.14s ease-in',
        cxmsg: 'cxmsg 0.34s cubic-bezier(0.22, 1, 0.36, 1) both',
        cxrise: 'cxrise 0.28s cubic-bezier(0.22, 1, 0.36, 1) both',
      },
    },
  },
  plugins: [],
};

export default config;
