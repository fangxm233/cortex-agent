Please update me when files in this folder change

WebSocket client, command execution, watchdog, and callback runtime.

| filename | role | function |
|---|---|---|
| auth-headers.ts | security | Builds client authentication headers |
| client.ts | client | Connects to the server and executes commands |
| cortex-md-scanner.ts | scanner | Scans ancestor CORTEX.md files |
| cortex-run-launch.ts | launcher | Launches runs and delivers completion callbacks |
| cortex-run-watcher.test.ts | test | Tests cortex run behavior |
| cortex-run-watcher.ts | watcher | Runs commands with stall detection |
| log.ts | logging | Writes client runtime logs |
| paths.ts | paths | Defines client data paths |
| server-url.ts | config | Resolves the server WebSocket URL |
