Please update me when files in this folder change

Process and command-line entry points for agent-server.
Composes the runtime from the other layers and starts the server, daemon, CLI, and Web UI.

| filename | role | function |
|---|---|---|
| admin-channel-hot-reload.ts | wiring | creates adapter with live admin settings |
| app.ts | entry | Wires guarded boot jobs, immutable trial config and attempt evidence |
| auth-cli.ts | cli | handles auth status arguments and rendering |
| boot-jobs.ts | wiring | registers optional client and archive timers |
| cli-help.ts | cli | builds top-level and subcommand help |
| cli.ts | entry | dispatches the full operator CLI handlers |
| cortex-cli.ts | entry | boots the operator CLI package command |
| daemon.ts | entry | supervises app with shared resilient monitors |
| daemon-notice.ts | wiring | broadcasts supervisor notices to the operator |
| draft-attachments.ts | files | promotes draft uploads into session storage |
| doctor-cli.ts | cli | runs environment diagnostics and safe fixes |
| hook-cli.ts | cli | Inspects hooks and runs blocking user asks |
| feishu-login.ts | cli | handles Feishu login and serialized env updates |
| init.ts | cli | creates Cortex home and MCP composition files |
| production-app-bootstrap.ts | entry | Consumes one-shot server auth before importing the sealed production app |
| production-evidence-export-cli.ts | cli | Publishes production benchmark evidence v2 |
| provider-cli.ts | cli | manages user-defined PI providers from the CLI |
| start-ui-http.ts | wiring | starts Web UI HTTP, CORS, and file routes |
| startup-helpers.ts | util | Gates managed startup mutations and prepares MCP config |
| startup-notify.ts | util | sends startup notices to the admin channel |
| ui-http-gate.ts | gate | loads the Web UI server when enabled |
