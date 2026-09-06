Please update me when files in this folder change

One web tab: it previews a local or forwarded HTTP service in a sandboxed frame.
The tab list and the strip belong to `features/dock`; this folder owns a single tab's model and body.

| filename | role | function |
|---|---|---|
| WebBody.tsx | view | Renders one tab's toolbar, port picker, notices and frame |
| WebBody.test.tsx | test | Tests navigation, frame identity and port provenance |
| BrowserButton.tsx | view | Opens a web tab in the dock |
| forward.ts | core | Lists ports and runs forwards through typed canonical native capabilities |
| frame-title.ts | core | Validates title messages from preview frames |
| frame-title.test.ts | test | Tests title message validation and frame routing |
| browser-target.ts | vm | Models URLs, history, titles, forwards and one tab's port chip |
| browser-target.test.ts | test | Tests URL guards, history and a single tab's identity |
