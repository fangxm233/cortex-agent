Please update me when files in this folder change

Standalone cortex-client daemon: runs file and shell commands sent by the
agent-server, and supervises long-running jobs on the local device.

| filename | role | function |
|---|---|---|
| auth-headers.ts | util | Resolves the client token and auth header |
| client.ts | entry | Runs the daemon and remote command handlers |
| cortex-md-scanner.ts | util | Collects CORTEX.md rules for a local file |
| cortex-run-launch.ts | core | Launches runs and reports their callbacks |
| cortex-run-watcher.test.ts | test | Covers watcher parsing, stalls and results |
| cortex-run-watcher.ts | entry | Supervises a spawned run and records state |
| log.ts | util | Provides console and rotating file logging |
| paths.ts | util | Defines client data, config and log paths |
| server-url.ts | util | Resolves the server WebSocket URL |
