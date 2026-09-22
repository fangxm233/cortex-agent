Please update me when files in this folder change.

Application menu presentation, keyboard shortcuts, and native window actions.

| filename | role | function |
|---|---|---|
| MenuBar.tsx | view | Render compact menus with readable shortcuts |
| menu-model.ts | model | Define menus and accelerator formatting |
| menu-model.test.ts | test | Verify menu traversal and accelerators |
| useAppMenus.ts | hook | Compose app menu actions and state |
| useAppMenus.test.tsx | test | Verify app menu navigation actions |
| useMenuShortcuts.ts | hook | Dispatch keyboard menu accelerators |
| useNativeMenu.ts | adapter | Install app menus in native shells |
| useWindowActions.ts | hook | Expose native window action state |
| useWindowActions.test.tsx | test | Verify window actions and state |
| window-commands.ts | adapter | Bridge native window commands |
| window-commands.test.ts | test | Verify native window command dispatch |
