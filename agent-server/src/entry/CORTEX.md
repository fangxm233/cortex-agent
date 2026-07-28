Please update me when files in this folder change

Process and command-line entry points for agent-server.
Composes the runtime from the other layers and starts the server, daemon, CLI, and Web UI.

| filename | role | function |
|---|---|---|
| app.ts | entry | wires and starts the agent-server runtime |
| cli.ts | entry | dispatches the cortex command line |
| daemon.ts | entry | supervises and restarts the app process |
| doctor-cli.ts | cli | runs environment diagnostics and safe fixes |
| feishu-login.ts | cli | handles Feishu user login and logout |
| init.ts | cli | creates the Cortex home directory and configs |
| start-ui-http.ts | wiring | starts the Web UI HTTP and SSE server |
| startup-helpers.ts | util | cleans old logs and prepares MCP config |
| startup-notify.ts | util | sends startup notices to the admin channel |
| ui-http-gate.ts | gate | loads the Web UI server when enabled |
