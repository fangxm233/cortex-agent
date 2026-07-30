Please update me when files in this folder change

Process and command-line entry points for agent-server.
Composes the runtime from the other layers and starts the server, daemon, CLI, and Web UI.

| filename | role | function |
|---|---|---|
| app.ts | entry | Wires runtime, lifecycle hooks and resume wakes |
| cli.ts | entry | dispatches the cortex command line |
| daemon.ts | entry | supervises and restarts the app process |
| daemon-notice.ts | wiring | broadcasts supervisor notices to the operator |
| doctor-cli.ts | cli | runs environment diagnostics and safe fixes |
| hook-cli.ts | cli | Inspects hooks and runs blocking user asks |
| feishu-login.ts | cli | handles Feishu user login and logout |
| init.ts | cli | creates Cortex home and runtime configuration |
| start-ui-http.ts | wiring | starts Web UI HTTP with settings-backed CORS |
| startup-helpers.ts | util | cleans old logs and prepares MCP config |
| startup-notify.ts | util | sends startup notices to the admin channel |
| ui-http-gate.ts | gate | loads the Web UI server when enabled |
