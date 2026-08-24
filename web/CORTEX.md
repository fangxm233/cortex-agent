Please update me when files in this folder change

Cortex Web UI package: a Vite and React single-page app that talks to the agent server over tRPC.
Holds build tooling, design tokens and the source tree; the built bundle also ships inside the native shells.

| filename | role | function |
|---|---|---|
| index.html | entry | Loads tokens and resolves appearance before paint |
| vite.config.ts | config | Build stamp, path alias, dev API proxy and test worker cap |
| tailwind.config.ts | config | Design tokens, compact menu chrome and animations |
| postcss.config.js | config | Enables Tailwind and autoprefixer processing |
| tsconfig.json | config | Strict TypeScript options and path alias |
| package.json | config | Scripts, UI primitives and native link bridge |
| .gitignore | config | Excludes the build output from git |
| public/ | assets | Shared theme tokens and browser icons |
| src/ | subdir | All application source code |
