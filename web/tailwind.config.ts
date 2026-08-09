// input:  source globs and shared CSS-variable design tokens/keyframes
// output: Tailwind build configuration for generated utility classes
// pos:    web styling compiler config; toast timing is presentation-owned
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { Config } from 'tailwindcss';

// Single source of truth for the Cortex UI design tokens (design §5, v2 定稿).
// No screen may hard-code a hex value — every color/space/radius/shadow/font below
// is consumed as a Tailwind token. Status pills and mono text are built from `pill`
// and `fontFamily.mono` respectively.
const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  // Dark theme is driven by `data-theme="dark"` on <html> (set by src/theme + the no-flash script in
  // index.html), NOT by the OS media query — the theme is a persisted user choice. All token hexes
  // below resolve to CSS variables (defined in src/index.css `:root` / `[data-theme='dark']`), so a
  // single attribute flip re-themes every token consumer. See design/ref/scheme-dark.dc.html.
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // State palette
        state: {
          ink: 'var(--state-ink)',
          run: 'var(--state-run)',
          wait: 'var(--state-wait)',
          done: 'var(--state-done)',
          fail: 'var(--state-fail)',
          gray: 'var(--state-gray)',
        },
        // Status-pill tinted bg/fg pairs
        pill: {
          'running-bg': 'var(--pill-running-bg)',
          'running-fg': 'var(--pill-running-fg)',
          'waiting-bg': 'var(--pill-waiting-bg)',
          'waiting-fg': 'var(--pill-waiting-fg)',
          'done-bg': 'var(--pill-done-bg)',
          'done-fg': 'var(--pill-done-fg)',
          'failed-bg': 'var(--pill-failed-bg)',
          'failed-fg': 'var(--pill-failed-fg)',
          'cancelled-bg': 'var(--pill-cancelled-bg)',
          'cancelled-fg': 'var(--pill-cancelled-fg)',
        },
        // Surfaces
        surface: {
          card: 'var(--proto-card)',
          canvas: 'var(--surface-base)', // prototype html/body base (was #F0EEE9; realigned §8.6 RA)
          'canvas-alt': 'var(--proto-alt)',
          rail: 'var(--proto-rail)',
        },
        // Prototype 1:1 palette (design §8.6 RA / task 6d21). Audited from
        // prototype.dc.html — the recurring structural ink/line/accent/amber
        // scale. Each resolves to a CSS var so it flips under `data-theme=dark`
        // (light/dark values in src/index.css). Per §8.3 one-off hexes may stay
        // raw in a screen; those are migrated to the same vars in the dark pass.
        proto: {
          base: 'var(--proto-base)',
          card: 'var(--proto-card)',
          rail: 'var(--proto-rail)',
          alt: 'var(--proto-alt)',
          gray: 'var(--proto-gray)',
          // ink / text scale (darkest → faint)
          ink: 'var(--proto-ink)',
          'ink-2': 'var(--proto-ink-2)',
          'ink-3': 'var(--proto-ink-3)',
          muted: 'var(--proto-muted)',
          'muted-2': 'var(--proto-muted-2)',
          'muted-3': 'var(--proto-muted-3)',
          faint: 'var(--proto-faint)',
          // hairlines / borders
          line: 'var(--proto-line)',
          'line-2': 'var(--proto-line-2)',
          'line-3': 'var(--proto-line-3)',
          'line-4': 'var(--proto-line-4)',
          // accent (run / blue)
          accent: 'var(--proto-accent)',
          'accent-bg': 'var(--proto-accent-bg)',
          'accent-border': 'var(--proto-accent-border)',
          'accent-2': 'var(--proto-accent-2)',
          'accent-strong': 'var(--proto-accent-strong)',
          // amber (waiting / approvals)
          amber: 'var(--proto-amber)',
          'amber-fg': 'var(--proto-amber-fg)',
          'amber-bg': 'var(--proto-amber-bg)',
          'amber-border': 'var(--proto-amber-border)',
          'amber-accent': 'var(--proto-amber-accent)',
          // success (done)
          success: 'var(--proto-success)',
          'success-bg': 'var(--proto-success-bg)',
          // danger (failed)
          danger: 'var(--proto-danger)',
          'danger-bg': 'var(--proto-danger-bg)',
        },
      },
      borderColor: {
        card: 'var(--border-card)',
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
        'menu-row-y': '5px',
        '2g': '16px',
        '3g': '24px',
        '4g': '32px',
        '5g': '40px',
        '6g': '48px',
      },
      borderRadius: {
        card: '10px',
        menu: '8px',
      },
      boxShadow: {
        card: '0 1px 2px rgba(0,0,0,0.04), 0 1px 3px rgba(0,0,0,0.06)',
        overlay: '0 10px 38px rgba(0,0,0,0.20), 0 6px 12px rgba(0,0,0,0.12)',
        menu: '0 10px 28px rgba(16,24,40,0.14)',
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
        // 6s dwell for transient info toasts; warning/error toasts do not use this bar.
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
