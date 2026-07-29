Please update me when files in this folder change

Global command palette searching real sessions, threads and tasks plus fixed navigation commands.
Thread rows open details in place; page rows navigate and settings opens its overlay.

| filename | role | function |
|---|---|---|
| CommandPalette.tsx | view | Dispatches page, settings, and thread targets |
| palette-items.ts | vm | Builds route and modal rows from entities |
| palette-items.test.ts | test | Unit tests for palette row building |
| useCommandPalette.ts | hook | Toggles the palette on the keyboard shortcut |
