Please update me when files in this folder change

Terminal chat client of the agent server: renders the conversation, dashboard, and modals in a full-screen Ink app.
It talks to the daemon only over the WebSocket TUI protocol and keeps no server-side state.

| filename | role | function |
|---|---|---|
| App.tsx | layout | assembles the chat, panel, and modal views |
| index.tsx | entry | starts the terminal client and connects it |
| logic.ts | core | pure helpers for layout, scroll, and input state |
| raf-batch.ts | util | coalesces and throttles high-frequency updates |
| render-output.ts | util | provides a flicker-free stdout for Ink frames |
| slash-commands.ts | data | defines the slash command palette entries |
| turn-status.ts | util | parses a status message into a one-line summary |
| ws-client.ts | core | connects to the daemon and streams frames |
| components/ | subdir | screen, panel, and modal components |
| hooks/ | subdir | runtime state hooks for the client |
| render/ | subdir | markdown and rich-block renderers |
