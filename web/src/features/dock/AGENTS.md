Please update me when files in this folder change.

Resizable workspace dock with persistent document and browser tab bodies.

| filename | role | function |
|---|---|---|
| DockFileBody.tsx | view | Render opaque documents and readable file states |
| DockPane.tsx | layout | Keep glass chrome and opaque documents mounted |
| DockPane.test.tsx | test | Verify tab lifetime and document opacity |
| DockProvider.tsx | state | Manage dock tabs and split persistence |
| DockTabStrip.tsx | view | Render glass draggable dock tabs and controls |
| dock-chrome.css | style | Style dock tabs and accessible action states |
| dock-split.ts | utility | Calculate and persist dock split ratios |
| dock-tabs.ts | model | Define dock tab operations and identity |
| dock-tabs.test.ts | test | Verify dock tab operations and ordering |
| FileBar.tsx | view | Show file path and material toolbar actions |
| FileBar.test.tsx | test | Verify file control semantics and callbacks |
