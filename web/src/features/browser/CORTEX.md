Please update me when files in this folder change

The docked browser pane: previews an HTTP service (local dev server, or a remote one reached
through the port forward) inside the workbench, with its own address bar and history.
The security boundary is `previewOriginConflict` — the frame gets `allow-same-origin`, so the
target must never share an origin with the app page or the API. Design: `plan/embedded-browser.md`.

| filename | role | function |
|---|---|---|
| WebBody.tsx | view | Address bar, navigation, viewport presets and the preview frame |
| BrowserButton.tsx | view | Chat-header control that docks the browser pane |
| forward.ts | core | Starts/lists port forwards and reads server and device listening ports |
| browser-target.ts | vm | URL normalization, the origin guard, history math and viewport presets |
| browser-target.test.ts | test | Pins the origin guard, URL rules and history behaviour |
