Please update me when files in this folder change

App-shell update source, native adapter, copy, and desktop dialog content.
Provides prioritized shell updates to the shared prompt owner.

| filename | role | function |
|---|---|---|
| AppUpdateDialog.tsx | view | Displays shell update details and actions |
| useAppUpdate.ts | hook | Re-shows manual results and gates shell prompts |
| app-update.ts | core | Parses payloads and adapts native updates |
| app-update.test.ts | test | Tests shell payload parsing and store publication |
