Please update me when files in this folder change

App-shell update source, native adapter, copy, and desktop dialog content.
The neutral `features/update/` owner combines it with hot updates and gives this source priority.

| filename | role | function |
|---|---|---|
| AppUpdateDialog.tsx | view | Per-kind desktop content and actions inside the desktop update frame |
| useAppUpdate.ts | hook | Uses the shared typing gate and exposes install, skip, and later actions |
| app-update.ts | core | Unknown-payload parsing, copy helpers, store, and safe canonical-bridge event/command adapter |
| app-update.test.ts | test | Unit tests for shell payload parsing and store publication |
