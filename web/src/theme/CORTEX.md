Please update me when files in this folder change

Device-local appearance preferences for every UI shell: theme, background tone, accent hue and
intensity, and motion. The provider applies persisted document attributes consumed by the shared
semantic palette.

| filename | role | function |
|---|---|---|
| index.ts | barrel | Re-exports appearance controls, hooks, helpers and types |
| ThemeProvider.tsx | provider | Holds appearance state and follows system changes |
| theme.ts | util | Resolves, persists and applies appearance preferences |
| AccentPicker.tsx | view | Selects preset or continuous accent hues |
| AccentPicker.test.tsx | test | Tests accent preset, slider and reset interactions |
| theme.test.ts | test | Tests stored theme/accent and system behavior |
| theme-tokens.test.ts | test | Guards aliases, variant blocks, no-flash and literal-free consumers |
