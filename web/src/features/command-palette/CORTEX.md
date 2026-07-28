Please update me when files in this folder change

Global command palette searching real sessions, threads and tasks plus fixed navigation commands.
Selecting a row either navigates through the router or opens a modal in place.

| filename | role | function |
|---|---|---|
| CommandPalette.tsx | view | Renders the overlay and dispatches commands |
| palette-items.ts | vm | Builds and filters palette rows from entities |
| palette-items.test.ts | test | Unit tests for palette row building |
| useCommandPalette.ts | hook | Toggles the palette on the keyboard shortcut |
