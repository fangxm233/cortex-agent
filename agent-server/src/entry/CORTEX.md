Please update me when files in this folder change

Process and command-line entry points for agent-server.
Composes the runtime from the other layers and starts the server, daemon, CLI, and Web UI.

| filename | role | function |
|---|---|---|
| admin-channel-hot-reload.ts | wiring | creates adapter with live admin settings |
| app.ts | entry | Wires runtime services, auth actions, and event clients |
| auth-cli.ts | cli | handles auth status arguments and rendering |
| cli-help.ts | cli | builds top-level and subcommand help |
| cli.ts | entry | dispatches process and modular CLI handlers |
| daemon.ts | entry | supervises and restarts the app process |
| daemon-notice.ts | wiring | broadcasts supervisor notices to the operator |
| doctor-cli.ts | cli | runs environment diagnostics and safe fixes |
| hook-cli.ts | cli | Inspects hooks and runs blocking user asks |
| feishu-login.ts | cli | handles Feishu login and serialized env updates |
| init.ts | cli | creates Cortex home and MCP composition files |
| start-ui-http.ts | wiring | starts Web UI HTTP with settings-backed CORS |
| startup-helpers.ts | util | cleans old logs and prepares MCP config |
| startup-notify.ts | util | sends startup notices to the admin channel |
| ui-http-gate.ts | gate | loads the Web UI server when enabled |
