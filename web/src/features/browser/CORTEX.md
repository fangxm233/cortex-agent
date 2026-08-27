Please update me when files in this folder change

The docked browser previews local or forwarded HTTP services with single-row titled tabs.

| filename | role | function |
|---|---|---|
| WebBody.tsx | view | Renders titled tabs, port chips and browser controls |
| WebBody.test.tsx | test | Tests tab order, frame lifetime and port provenance |
| BrowserButton.tsx | view | Opens or hides the browser pane |
| forward.ts | core | Lists ports and starts forwards |
| frame-title.ts | core | Validates title messages from preview frames |
| frame-title.test.ts | test | Tests title message validation and frame routing |
| browser-target.ts | vm | Models URLs, titles, forwards, port chips and ordered tabs |
| browser-target.test.ts | test | Tests URL guards, history and tab identity |
