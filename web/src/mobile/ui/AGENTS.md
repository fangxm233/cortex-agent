Please update me when files in this folder change.

The mobile kit: shared presentational frames, controls and formatting every screen composes.
Pure — no data, no tRPC. Primitives features also render (`MBottomSheet`, the `MC`/`MONO`
tokens, the overlay host) live in `design/`; `kit.tsx` re-exports them so screens import one kit.

| filename | role | function |
|---|---|---|
| kit.tsx | UI | `MScreen`, `MTabHeader`, `MDrillHeader`, `MScrollBody`, `MCard`, `MPill`, `MDot`, `MSegmented`, `MGroupLabel` — floating glass header, cards and controls |
| composer.tsx | UI | `MComposer` + `ComposerFullscreen`: measurable floating composer chrome and its line/char count labels |
| format.ts | utility | `relTimeZh`, `fmtMoney`, and `pickCopy` (the screen-local COPY-table picker) |
