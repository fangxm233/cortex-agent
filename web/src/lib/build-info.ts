// Build-time stamp injected by Vite `define` (see web/vite.config.ts). Format: `MMDD-HHmm·<sha>` of
// the last commit touching the frontend, so it changes only when the frontend does and shows on-device
// which frontend an OTA swap landed (rendered in the mobile Settings footer). Falls back to 'dev' when the define
// pass did not run (e.g. vitest / dev server without the constant) — the `typeof` guard avoids a
// ReferenceError when the identifier was never substituted.
declare const __BUILD_STAMP__: string;

export const BUILD_STAMP: string =
  typeof __BUILD_STAMP__ !== 'undefined' ? __BUILD_STAMP__ : 'dev';
