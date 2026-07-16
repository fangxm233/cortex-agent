// Build-time stamp injected by Vite `define` (see web/vite.config.ts). Format: `MMDD-HHmm·<sha>`,
// recomputed on every `vite build`, so it changes each build and makes an OTA frontend swap visually
// verifiable on-device (rendered in the mobile Settings footer). Falls back to 'dev' when the define
// pass did not run (e.g. vitest / dev server without the constant) — the `typeof` guard avoids a
// ReferenceError when the identifier was never substituted.
declare const __BUILD_STAMP__: string;

export const BUILD_STAMP: string =
  typeof __BUILD_STAMP__ !== 'undefined' ? __BUILD_STAMP__ : 'dev';
