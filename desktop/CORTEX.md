Please update me when files in this folder change

Cortex Desktop — Tauri v2 shell that wraps the built web SPA in a native window.
Serves the SPA over a custom `cortexui://` URI scheme from a swappable frontend directory
(so the frontend can self-update — see "Frontend OTA" below) instead of the built-in read-only
asset protocol. The SPA talks directly to the remote Cortex server using absolute URLs — token
injection is handled by `web/src/lib/trpc.ts` (conditional transport) and wired up by
`web/src/providers.tsx` reading `window.__CORTEX_DESKTOP_CONFIG`.

## Frontend OTA (self-updating SPA)

The window loads `cortexui://localhost/<index|connect>.html`. A registered URI-scheme handler
(`register_uri_scheme_protocol("cortexui", …)`) serves each request from the **active frontend
directory**, resolved newest-first by `active_frontend_dir`:
1. `CORTEX_FRONTEND_DIR` env override (dev/testing — point straight at `web/dist`).
2. OTA-downloaded current version: `<appDataDir>/ui/current` (populated by the updater — unit C, not yet built).
3. Bundled seed shipped with the app: `<resourceDir>/frontend-seed` (first-run / offline fallback),
   staged by `bundle.resources` mapping `../../web/dist/` → `frontend-seed/` in tauri.conf.json.

`frontend.rs` holds the pure resolver (`resolve_asset`): percent-decode + path-traversal guard +
MIME + SPA fallback to index.html, mirroring the server's `serveSpaStub`. Native `std::fs` read —
no JS fs-plugin capability needed. A single origin (`cortexui://`) is kept for the SPA's whole
life so browser-origin state is stable across seed→OTA swaps.

The server side (agent-server `platform/ui-http/ui-ota.ts`) exposes the matching
`/api/ui-ota/manifest.json` + `/api/ui-ota/bundle.zip` (token-gated).

⚠️ **CORS origin change**: the webview Origin is now `cortexui://localhost` (Linux/macOS) or
`http://cortexui.localhost` (Windows), not `tauri://localhost`. The remote server's
`CORTEX_UI_CORS_ORIGINS` must list these new origins or the SPA's cross-origin tRPC calls are
blocked by the browser.

## First-run / connection flow

1. **No stored credentials** → Tauri opens `connect.html` (the connection config screen).
   User enters `serverUrl` + `clientToken`, clicks Test (probe), then Connect.
   JS calls the `connect` Tauri command → OS keychain save + AppState update.
   Page navigates to `index.html` (SPA workbench).

2. **Credentials in keychain** → Rust loads them at startup, opens `index.html` directly.
   `initialization_script` (injected on every page) runs an async IPC call to
   `get_connection_config` — resolves in microseconds, before the React bundle executes.
   `providers.tsx` reads `window.__CORTEX_DESKTOP_CONFIG` and passes it to `createTrpcClient()`.

3. **Switch / disconnect** → hover the "Switch" button (injected by `initialization_script`)
   → calls `disconnect` command (clears keychain + AppState) → navigates to `connect.html`.

## Package layout

```
desktop/
├── package.json              pnpm package: @tauri-apps/cli devDep, @tauri-apps/api dep
│                             scripts: copy-connect / dev / build
├── ui/
│   └── connect.html          Standalone connection config screen (design-to-match;
│                             IBM Plex Mono, #191C22/#4655D4/#23854F, settings-card).
│                             Copied to web/dist/connect.html by `npm run copy-connect`.
├── src-tauri/
│   ├── Cargo.toml            cortex-desktop crate (tauri v2 + serde + keyring v3)
│   ├── build.rs              tauri-build entry point
│   ├── tauri.conf.json       Tauri config: frontendDist=../../web/dist, withGlobalTauri
│   ├── capabilities/
│   │   └── default.json      Security capability (core:default)
│   ├── icons/                Placeholder icons
│   └── src/
│       ├── main.rs           Rust entry point (calls lib::run)
│       ├── lib.rs            AppState + keychain helpers + 4 Tauri commands +
│       │                     initialization_script + active_frontend_dir + cortexui:// scheme + run()
│       └── frontend.rs       Pure OTA asset resolver (resolve_asset: sanitize/traversal/MIME/SPA-fallback)
└── src-tauri/target/         Rust build output (gitignored)
```

## Tauri commands

| command | signature | purpose |
|---|---|---|
| `get_connection_config` | `() → ConnectionConfig` | Read current AppState credentials |
| `set_connection_config` | `(serverUrl?, token?) → void` | In-memory update (legacy; prefer `connect`) |
| `connect` | `(serverUrl, token) → Result<()>` | Save to OS keychain + update AppState |
| `disconnect` | `() → Result<()>` | Clear keychain + AppState |

## Injection mechanism

`initialization_script` (constant in `lib.rs`, injected on every page load):
1. Sets `window.__CORTEX_DESKTOP__ = true`
2. Starts async `invoke('get_connection_config')` → writes `window.__CORTEX_DESKTOP_CONFIG`
3. On DOMContentLoaded: if NOT on `connect.html`, adds a "Switch" hover button (bottom-right)

`web/src/providers.tsx` reads `window.__CORTEX_DESKTOP_CONFIG` at React mount and passes it to
`createTrpcClient()` — enabling absolute-URL + token-bearer mode for desktop.

## Files

| filename | role | function |
|---|---|---|
| `ui/connect.html` | connect screen | Standalone HTML/CSS/JS — serverUrl+token inputs, Test probe, Connect (keychain), Switch link |
| `src-tauri/src/lib.rs` | core | `AppState`, `ConnectionConfig`, keychain helpers, 4 Tauri commands, `INIT_SCRIPT`, `active_frontend_dir`, `cortexui://` scheme registration, `run()` |
| `src-tauri/src/frontend.rs` | OTA resolver | Pure `resolve_asset`/`sanitize_request_path`/`content_type` (traversal guard + MIME + SPA fallback); unit-tested |
| `src-tauri/src/main.rs` | entry | `#[cfg_attr windows_subsystem]` + `lib::run()` |
| `src-tauri/Cargo.toml` | manifest | `cortex-desktop` crate; tauri v2 + serde + keyring v3 |
| `src-tauri/build.rs` | build | `tauri_build::build()` |
| `src-tauri/tauri.conf.json` | config | `frontendDist: ../../web/dist`, `withGlobalTauri: true` |
| `src-tauri/capabilities/default.json` | security | `core:default` capability |
| `src-tauri/icons/` | assets | Placeholder icons |

## Config env vars (dev / testing)

| Variable | Purpose |
|---|---|
| `CORTEX_SERVER_URL` | Pre-seed serverUrl at startup (bypasses keychain, skips connect screen) |
| `CORTEX_TOKEN` | Pre-seed token at startup (bypasses keychain) |
| `CORTEX_FRONTEND_DIR` | Serve the SPA from this directory (highest priority in `active_frontend_dir`) — dev/testing without bundling a seed or downloading an OTA version |

## Scripts (from `desktop/` directory)

| Script | Command | What it does |
|---|---|---|
| `copy-connect` | `node -e "fs.mkdirSync('../web/dist',{recursive:true}); fs.copyFileSync('ui/connect.html','../web/dist/connect.html')"` | Stage connect screen into web/dist (cross-platform node one-liner — the old `mkdir -p && cp` shell form failed on Windows cmd.exe) |
| `dev` | `npm run copy-connect && tauri dev` | Copy connect.html + launch Tauri dev window |
| `build` | `npm run copy-connect && tauri build` | Copy connect.html + produce app bundle |

## System prerequisites (Linux)

```
sudo apt-get install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev
```

**Build order:** `pnpm --filter web build` → `pnpm --filter desktop build` (or `dev`).
The `copy-connect` step runs automatically as part of `dev`/`build`.

## Keychain notes

- Uses `keyring` crate v3 (OS-native: SecretService on Linux, Keychain on macOS, CredMan on Windows).
- If the secret-service daemon is not running (headless Linux), save fails silently; credentials
  are kept in AppState for the session only (lost on restart). Use env vars as alternative.
- Keychain entry: service=`dev.cortex.desktop`, account=`connection`, value=JSON `ConnectionConfig`.
