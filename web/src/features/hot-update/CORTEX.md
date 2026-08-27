Please update me when files in this folder change

Over-the-air frontend update source, native adapter, and desktop dialog content.
The neutral `features/update/` owner combines it with app-shell updates and applies shared typing gating.

| filename | role | function |
|---|---|---|
| HotUpdateDialog.tsx | view | Desktop apply/ignore content inside the desktop update frame |
| useHotUpdate.ts | hook | Subscribes to staged updates and exposes shared-gated apply/dismiss state |
| useHotUpdate.test.ts | test | Compatibility tests for editable-target gating used by the source |
| frontend-update.ts | core | Parses unknown staged payloads, uses safe canonical bridge events/commands and adapts byte labels |
| frontend-update.test.ts | test | Tests staged shell payload parsing and malformed fields |
