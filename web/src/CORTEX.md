Please update me when files in this folder change

Application source root: boots React, installs the global providers and picks the router per shell.
Splits into shared layers (design, i18n, theme, lib) and screen layers (features, mobile, shell).

| filename | role | function |
|---|---|---|
| main.tsx | entry | Mounts the React root with providers and router |
| providers.tsx | provider | Nests global clients, themes and login overlay |
| RootRouter.tsx | core | Chooses the mobile or desktop router |
| router.tsx | core | Declares the separate desktop page routes under the app shell |
| router-factory.ts | core | Selects hash history for native shells and browser history otherwise |
| router-factory.test.ts | test | Verifies shared native/browser router selection |
| index.css | style | Global styles, palette chrome and usage animations |
| vite-env.d.ts | types | Vite client ambient type declarations |
| design/ | subdir | Token-driven shared UI primitives |
| features/ | subdir | Product features consuming shared transports and typed native capabilities |
| i18n/ | subdir | Language state, vocabulary and viewport hook |
| lib/ | subdir | Transport, typed native bridge, shell, file and external-link helpers |
| mobile/ | subdir | Mobile routes, scoped native taps and settings |
| shell/ | subdir | Persistent desktop layout frame with bridge-backed native actions |
| theme/ | subdir | Theme and device-local accent state and controls |
