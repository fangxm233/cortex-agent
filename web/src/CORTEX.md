Please update me when files in this folder change

Application source root: boots React, installs the global providers and picks the router per shell.
Splits into shared layers (design, i18n, theme, lib) and screen layers (features, mobile, shell).

| filename | role | function |
|---|---|---|
| main.tsx | entry | Mounts the React root with providers and router |
| providers.tsx | provider | Nests the global providers around the app |
| RootRouter.tsx | core | Chooses the mobile or desktop router |
| router.tsx | core | Declares desktop routes under the app shell |
| index.css | style | Theme variables, base layer and animations |
| vite-env.d.ts | types | Vite client ambient type declarations |
| design/ | subdir | Token-driven shared UI primitives |
| features/ | subdir | One folder per product feature or overlay |
| i18n/ | subdir | Language state, vocabulary and viewport hook |
| lib/ | subdir | Transport, shell bridge and file helpers |
| mobile/ | subdir | Mobile shell, routes and phone screens |
| shell/ | subdir | Persistent desktop layout frame |
| theme/ | subdir | Light and dark theme state |
