Please update me when files in this folder change

Remote domain: links the server to cortex-client daemons running on other devices.
Covers client deployment, updates, the connection registry, and the client daemon itself.

| filename | role | function |
|---|---|---|
| client-bootstrap.ts | cli | Deploys cortex-client to a remote device |
| client-hot-reload.ts | core | Updates and restarts clients to the latest build |
| client-manager.ts | core | Routes clients and emits connection hooks |
| cortex-client-config.ts | config | Resolves client connection URL and auth headers |
| cortex-client.ts | entry | Runs the client daemon on a remote device |
