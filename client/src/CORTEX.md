Please update me when files in this folder change

Standalone cortex-client daemon: runs file and shell commands sent by the
agent-server, and supervises long-running jobs on the local device.

| filename | role | function |
|---|---|---|
| auth-headers.ts | util | Resolves the client token and auth header |
| client.ts | entry | Runs the daemon and remote command handlers |
| command-exec.ts | core | Runs bounded shell commands and kills process trees |
| cortex-md-scanner.ts | util | Collects CORTEX.md rules for a local file |
| cortex-run-launch.ts | core | Persists runs and reports owned task callbacks |
| cortex-run-watcher.test.ts | test | Covers duration/GPU parsing, stall branches, state/results and process termination |
| cortex-run-watcher.ts | entry | Supervises a spawned run and records state |
| log.ts | util | Provides console and rotating file logging |
| paths.ts | util | Defines client data, config and log paths |
| reverse-stream.ts | core | Dials back a WebSocket per requested TCP connection to a local service |
| server-url.ts | util | Resolves the server WebSocket URL |
