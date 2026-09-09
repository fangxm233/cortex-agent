Please update me when files in this folder change

Over-the-air frontend update source, native adapter, and desktop dialog content.
Provides gated frontend updates to the shared prompt owner.

| filename | role | function |
|---|---|---|
| HotUpdateDialog.tsx | view | Displays frontend update details and actions |
| useHotUpdate.ts | hook | Re-shows manual results and gates frontend prompts |
| useHotUpdate.test.ts | test | Tests editable-target gating compatibility |
| frontend-update.ts | core | Parses staged payloads and adapts native updates |
| frontend-update.test.ts | test | Tests staged payload parsing and malformed fields |
