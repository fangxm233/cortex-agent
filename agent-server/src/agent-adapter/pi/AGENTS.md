Please update me when files in this folder change.

Pi backend adapters, session runtimes, and Cortex extension bridges.

| filename | role | function |
|---|---|---|
| adapter.ts | adapter | Implement the Pi agent adapter |
| agent-dir.ts | utility | Prepare private Pi agent configuration |
| background-subagent.ts | type | Define background subagent contracts |
| child-events.ts | adapter | Forward child events and usage |
| child-runner.ts | core | Execute and cancel child runs |
| child-session.ts | core | Create warming-disabled child sessions |
| custom-catalog.ts | utility | Discover user-defined Pi models |
| defaults.ts | utility | Define default Pi data paths |
| discovery.ts | core | Discover authenticated Pi providers |
| engine.ts | adapter | Resolve Pi engine specifications |
| event-parser.ts | adapter | Convert Pi events to Cortex events |
| extensions.ts | adapter | Assemble Cortex inline extensions |
| hook-bridge.ts | adapter | Bridge hooks with read-only prompt support |
| mcp-bridge-logic.ts | utility | Normalize MCP tool results and policy |
| mcp-bridge.ts | adapter | Connect MCP servers to Pi tools |
| pi-session.ts | core | Drive pooled Pi session turns |
| providers-config.ts | utility | Build gateway-routed model configuration |
| quota-probe.ts | utility | Probe provider quotas |
| quota-sink.ts | adapter | Forward provider quota headers |
| runtime.ts | core | Create main Pi session runtimes |
| runtime-settings.ts | utility | Disable runtime warming without persistence |
| session-files.ts | utility | Locate and read Pi session files |
| session-options.ts | utility | Build session requests and environment |
| session-support.ts | utility | Manage prompt and event queues |
| subagent-bridge.ts | adapter | Bridge Cortex subagent lifecycle |
| subagent.ts | adapter | Register the Pi subagent tool |
| tool-shims.ts | adapter | Register Cortex-compatible Pi tools |
| ui-context.ts | adapter | Forward extension UI interactions |
| web-fetch.ts | utility | Fetch web content for Pi tools |
| web-search.ts | utility | Search the web for Pi tools |
