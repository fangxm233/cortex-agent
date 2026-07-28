Please update me when files in this folder change

Cortex Web UI package: a Vite and React single-page app that talks to the agent server over tRPC.
Holds build tooling, design tokens and the source tree; the built bundle also ships inside the native shells.

| filename | role | function |
|---|---|---|
| index.html | entry | Hosts the app root and applies theme before paint |
| vite.config.ts | config | Build stamp, path alias and dev API proxy |
| tailwind.config.ts | config | Design tokens, dark mode and animation utilities |
| postcss.config.js | config | Enables Tailwind and autoprefixer processing |
| tsconfig.json | config | Strict TypeScript options and path alias |
| package.json | config | Scripts and runtime dependencies |
| .gitignore | config | Excludes the build output from git |
| public/ | assets | Favicons and the touch icon |
| src/ | subdir | All application source code |
