Please update me when files in this folder change

App shell update prompt for the native app, fed by the shell's downloaded-and-verified update.
Supersedes the hot-update prompt while pending; installing hands off per platform.

| filename | role | function |
|---|---|---|
| AppUpdateProvider.tsx | provider | Mounts the prompt when a shell update is ready |
| AppUpdateDialog.tsx | view | Per-kind update prompt with install, skip, later |
| useAppUpdate.ts | hook | Surfaces the update with install and skip actions |
| app-update.ts | core | Shell bridge, pure copy helpers and the store |
| app-update.test.ts | test | Unit tests for parsing, copy and the store |
