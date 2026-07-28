Please update me when files in this folder change

React state hooks of the terminal client: connection, transcript, dashboard data, notifications, keys, and mouse.
They hold the client-side runtime state that the screen components render.

| filename | role | function |
|---|---|---|
| useDashboardData.ts | hook | keeps per-tab dashboard data current |
| useKeybindings.ts | hook | maps global keys to client actions |
| useMouseHandler.ts | hook | turns mouse input into scroll and selection |
| useMutate.ts | hook | sends mutations and awaits their results |
| useNotifications.ts | hook | stores recent notifications and unread count |
| useTranscript.ts | hook | builds transcript messages from server frames |
| useWsClient.ts | hook | manages the connection and frame stream |
