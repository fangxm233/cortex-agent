Please update me when files in this folder change

Light and dark color theme as a persisted user choice, defaulting to the OS color-scheme preference.
Applied by toggling a data-theme attribute on the document root, which switches the CSS variables.

| filename | role | function |
|---|---|---|
| index.ts | barrel | Re-exports theme hooks, helpers and types |
| ThemeProvider.tsx | provider | Holds theme state and exposes set and toggle |
| theme.ts | util | Resolves, persists and applies the color theme |
| theme.test.ts | test | Unit tests for initial theme resolution |
