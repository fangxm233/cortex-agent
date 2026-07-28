Please update me when files in this folder change

PlatformAdapter's concrete platform implementations. Each adapter is a thin bridge, unified to the PlatformAdapter interface.

**Multi-platform conduit prefixing**: Slack/Feishu/TUI can run simultaneously behind `CompositeAdapter`. Each adapter exposes conduits in a canonical prefixed form (`slack:`, `feishu:`, `tui-`) at its boundary and strips the prefix before calling its SDK / reading-writing its bare-id registry. Routing uses `ownsConduit(conduit)`. See `composite-adapter.ts`.

| filename | role | function |
|---|---|---|
| `index.ts` | factory | Select & compose adapters by CORTEX_PLATFORM (comma list, e.g. `slack,feishu`) / CORTEX_TUI — `createPrimaryAdaptersFromEnv` (N primaries) + `createAdapterFromEnv` (0→throw, 1→bare, ≥2→composite). `createPrimaryAdapterFromEnv` kept as back-compat shim |
| `slack.ts` | adapter | Slack messaging plus rate-limited hourglass add/remove |
| `slack-output-stream.ts` | output stream | SlackOutputStream — coalescing OutputStream for Slack: content coalescing, mutable tail, table/HR split heuristics, retry backoff, pendingEdits-based `updateMessage` |
| `project-conduits.ts` | store | Platform-agnostic file-backed project→conduit mapping (JsonRepository; filePath defaults to STORE_DIR/channel-registry.json, Feishu passes feishu-channel-registry.json) |
| `slack-project-conduits.ts` | store | Backward-compat alias: re-exports `ProjectConduitsStore` as `SlackProjectConduitsStore` |
| `feishu.ts` | adapter | Feishu messaging plus reaction-id-backed OnIt add/remove |
| `feishu-output-stream.ts` | output stream | FeishuOutputStream — coalesces streamed text into one growing card via card patch (im.v1.message.patch); openMutable is a real region (tool-call traces render); overflow chunks thread under the first message (reply_in_thread, Slack-style) |
| `tui/` | subdirectory | TUI WebSocket adapter and no-op marker removal surface |
| `composite-adapter.ts` | adapter | Routes outbound and marker lifecycle calls by conduit prefix |
