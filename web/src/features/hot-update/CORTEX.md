Please update me when files in this folder change

Over-the-air frontend update prompt for the native shell, driven by a staged-bundle event.
Applying relaunches the app so the staged bundle is promoted; in a plain browser it is a no-op.

| filename | role | function |
|---|---|---|
| HotUpdateProvider.tsx | provider | Mounts the prompt when a bundle is staged |
| HotUpdateDialog.tsx | view | New-version prompt with apply and ignore |
| useHotUpdate.ts | hook | Exposes the staged update with apply and dismiss |
| useHotUpdate.test.ts | test | Unit tests for the hot update hook |
| frontend-update.ts | core | Bridges staged bundle events and apply to shell |
| frontend-update.test.ts | test | Unit tests for the native update bridge |
