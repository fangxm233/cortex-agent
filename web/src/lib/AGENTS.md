Please update me when files in this folder change.

The floor of the stack: platform detection, transport, browser-session auth and pure
helpers. `lib-is-bottom` forbids importing `features/ mobile/ shell/ i18n/ design/ theme/`
from here — no app knowledge, not even vocab. Everything above may import it.

| filename | role | function |
|---|---|---|
| trpc.ts | core | The tRPC client factory + React context; batch headers and the SSE fetch, remote-config or same-origin |
| ui-session.ts | core | Browser-mode auth seam: probe / login / logout, token posted once and exchanged for an HttpOnly cookie |
| desktop-config.ts | core | Read the Tauri-injected `window.__CORTEX_DESKTOP_CONFIG`; `apiBase`, `authHeaders`, `isDesktopShell` / `isMobileShell` / `isNativeShell` |
| desktop-platform.ts | utility | Synchronous native-shell identity: platform, title-bar mode, command key, caption insets |
| native-bridge.ts | core | The one canonical Tauri command/event bridge: capabilities, `safeInvoke`, native notifications, back-button listener |
| shell-connection.ts | core | Disconnect: clear saved credentials (SPA + shell keychain) and return to the connect screen |
| files.ts | core | File download / copy-path / open / reveal, routed to native commands inside a WebView |
| external-navigation.ts | utility | `openExternalUrl` — native opener when available, `window.open` otherwise |
| markdown.ts | core | The markdown parser (frontmatter, inline nodes, blocks). Pure, JSX-free — `design/ChatMarkdown` renders its output |
| sensitive-transport.ts | core | Credential transport policy + `credentialSafeFetch`: platform secrets never go over remote plaintext HTTP |
| use-mobile-layout.ts | core | `useMobileLayout` / `useIsMobile` — the single source of truth for the layout switch (native mobile always, else the width query) |
| useUpdateGating.ts | utility | Suppress update prompts while the user is typing into an editable target |
| useRecentNow.ts | utility | One shared ticker so "3m ago" labels re-render together |
| manual-update-check-result.ts | core | Publish/subscribe seam for a manual update-check report; knows no channel and runs no check |
| format.ts | utility | `formatUsd`, `formatBytes`, `formatDurationShort` |
| build-info.ts | utility | `BUILD_STAMP`, the Vite-injected `MMDD-HHmm·<sha>` build marker |
| `*.test.ts(x)` | test | vitest, colocated — 12 files, covering config, transport, files, markdown, the native bridge, both session seams and the layout switch |
