Please update me when files in this folder change

Shared desktop File / Edit / View / Help menus, native menu synchronization and keyboard accelerators.
Manual update checks expose busy state without owning update prompts.

| filename | role | function |
|---|---|---|
| menu-model.ts | util | Defines menu nodes and accelerator rules |
| menu-model.test.ts | test | Tests accelerator matching and native serialization |
| useAppMenus.ts | core | Assembles menus and manual update check action |
| useAppMenus.test.tsx | test | Tests removed entries, separators and busy action |
| useMenuShortcuts.ts | core | Runs menu accelerators on keyboard input |
| useWindowActions.ts | core | Controls native window, zoom and devtools |
| MenuBar.tsx | view | Renders dropdowns, submenus and check marks |
| useNativeMenu.ts | core | Synchronizes macOS menus and routes clicks |
