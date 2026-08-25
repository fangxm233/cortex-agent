Please update me when files in this folder change

Device-local appearance preferences for every UI shell: theme, palette, accent, and motion.
The provider persists the controls and applies them through shared semantic tokens.

| filename | role | function |
|---|---|---|
| index.ts | barrel | Re-exports appearance controls, hooks, helpers and types |
| ThemeProvider.tsx | provider | Holds appearance state and follows system changes |
| theme.ts | util | Resolves and applies theme, accent, and motion |
| palette.ts | model | Validates, stores, and applies palette parameters |
| palette-presets.ts | config | Defines named palettes and matches active presets |
| PaletteControls.tsx | view | Edits palette presets and individual parameters |
| AccentPicker.tsx | view | Selects preset or continuous accent hues |
| AccentPicker.test.tsx | test | Tests accent preset, slider and reset interactions |
| theme.test.ts | test | Tests stored appearance state and DOM application |
| theme-tokens.test.ts | test | Guards aliases, no-flash, and raw-color boundaries |
