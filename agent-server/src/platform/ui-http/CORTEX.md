Please update me when files in this folder change

Web UI transport host: serves the tRPC API over HTTP and SSE plus the built single-page app.
Also serves the desktop frontend update bundle and the app shell update manifest.

| filename | role | function |
|---|---|---|
| ui-http-server.ts | http | Hosts authenticated tRPC, SPA, live CORS and the port-forward upgrade |
| access-jwt.ts | auth | Verifies Cloudflare Access browser tokens |
| port-forward.ts | http | Forwards a loopback TCP service over WebSocket and lists listening ports |
| browser-status.ts | http | Reports where the managed browser draws and whether a human can take it over |
| device-ports.ts | http | Lists online devices, their listening ports, and maps one onto this server |
| ui-ota.ts | http | Serves the frontend update manifest and bundle |
| app-update.ts | http | Advertises native app releases from GitHub |
| zip-writer.ts | util | Packs in-memory files into a ZIP archive |
