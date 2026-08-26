Please update me when files in this folder change

Remote domain: links the server to cortex-client daemons running on other devices.
Covers client deployment, updates, the connection registry, and the client daemon itself.

| filename | role | function |
|---|---|---|
| client-bootstrap.ts | cli | Ships the managed client bundle to a remote device |
| client-hot-reload.ts | core | Publishes the desired client bundle; devices self-update on hello |
| client-manager.ts | core | Routes clients, reverse-stream callbacks, and fences remote task callbacks |
| client-ssh-tunnel.ts | core | Supervises SSH reverse routes for remote clients |
| reverse-stream.ts | core | Mints and pairs device-dialed streams for server→device connections |
| cortex-client-config.ts | config | Resolves client connection URL and auth headers |
| cortex-client.ts | entry | Runs the client daemon on a remote device |
| device-browser.ts | core | Launches and holds a managed Chrome on a device, reachable as a local endpoint |
| device-chrome-commands.ts | core | Builds interactive Windows and direct Unix Chrome commands |
| device-port.ts | core | Maps a port on a device onto a loopback port on this server |
