Please update me when files in this folder change

Process and command-line entry points that compose server dependencies.

| filename | role | function |
|---|---|---|
| app.ts | entry | Composes and starts the server runtime |
| cli.ts | entry | Dispatches command-line subcommands |
| daemon.ts | entry | Supervises and restarts the server process |
| doctor-cli.ts | entry | Runs diagnostics from the command line |
| feishu-login.ts | entry | Runs the Feishu login flow |
| init.ts | entry | Initializes the Cortex data directory |
| start-ui-http.ts | entry | Starts the UI HTTP transport |
| startup-helpers.ts | helper | Prepares startup configuration and logs |
| startup-notify.ts | notice | Sends startup and restart notices |
| ui-http-gate.ts | gate | Loads the UI transport when enabled |
