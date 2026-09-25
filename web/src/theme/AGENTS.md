Please update me when files in this folder change.

Runtime appearance: light/dark theme, accent hue and intensity, motion policy and the six
palette parameters that drive every surface/text token in `public/theme.css`. Pure state +
DOM application — `foundation-not-to-app` forbids importing `features/ mobile/ shell/`.

| filename | role | function |
|---|---|---|
| index.ts | entry | Barrel: the provider, all `use*` hooks, and the storage/apply helpers |
| ThemeProvider.tsx | core | The context: theme, accent hue/intensity, motion mode and palette, with their setters and preset actions |
| theme.ts | core | Theme/accent/motion model — types, defaults, storage keys, `resolveInitialTheme`, `watchSystemTheme`, the `apply*` DOM writers |
| palette.ts | core | The six palette parameters: ranges, clamping, parse/read/store, `applyPalette` |
| palette-presets.ts | type | Named `PALETTE_PRESETS` + `matchPreset` (which preset the current values equal) |
| PaletteControls.tsx | core | The palette editor UI (sliders + presets + reset, exact colour previews), used by both chromes' appearance surfaces |
| AccentPicker.tsx | core | Accent hue / intensity picker; takes its copy as props so it stays vocab-free |
| ColorSlider.tsx | core | Keyboard- and touch-sized range slider with a painted track, shared by `AccentPicker` and `PaletteControls` |
| color-slider.css | style | Track and thumb styling for `ColorSlider` (44px touch height on narrow viewports) |
