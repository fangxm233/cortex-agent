Please update me when files in this folder change

Light, dark, and system-following color theme as a persisted user preference.
Resolved to a data-theme attribute on the document root, which switches the CSS variables.

| filename | role | function |
|---|---|---|
| index.ts | barrel | Re-exports theme hooks, helpers and types |
| ThemeProvider.tsx | provider | Holds theme state and follows system changes |
| theme.ts | util | Resolves, persists, applies and watches the theme |
| theme.test.ts | test | Tests stored, effective and system theme behavior |
| theme-tokens.test.ts | test | Guards shared tokens and literal-free consumers |
