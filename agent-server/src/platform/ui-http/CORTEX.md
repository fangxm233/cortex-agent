Please update me when files in this folder change

Web UI transport host: serves the tRPC API over HTTP and SSE plus the built single-page app.
Also serves the desktop frontend update bundle and the app shell update manifest.

| filename | role | function |
|---|---|---|
| ui-http-server.ts | http | Hosts the tRPC router and the SPA behind auth |
| access-jwt.ts | auth | Verifies Cloudflare Access browser tokens |
| ui-ota.ts | http | Serves the frontend update manifest and bundle |
| app-update.ts | http | Advertises native app releases from GitHub |
| zip-writer.ts | util | Packs in-memory files into a ZIP archive |
