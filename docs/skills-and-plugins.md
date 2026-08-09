# Cortex Skills and Plugins

Cortex uses skills for reusable agent instructions and plugins for installable capability bundles. A plugin can contribute skills alone or, when it follows the portable Agent Plugins format, skills together with Model Context Protocol (MCP) servers. Plugin assignment is scoped to an agent or a template slot, so each spawned backend receives only the selected surface.

## Skills

A skill is a directory whose entry point is `SKILL.md`. Its YAML frontmatter describes when the skill applies, while the Markdown body provides the instructions expanded by the `Skill` tool. A minimal portable skill looks like this:

```yaml
---
name: summarize
description: Use when a long artifact needs a concise technical summary
---

# Summarize

Read the complete artifact, preserve evidence links, and report the main result.
```

The directory name and frontmatter `name` must match. Portable skills use lowercase letters, digits, and single hyphens, and Cortex discovers only immediate children of the plugin's `skills/` directory. A skill can keep supporting files such as scripts and references below its own directory.

Cortex also scans `$CORTEX_HOME/.claude/skills/` for standalone user skills. Those standalone skills remain separate from the plugin catalog and from plugin assignment.

## Supported plugin formats

Cortex inventories each immediate child directory of `$CORTEX_HOME/plugins/`. It recognizes the portable Agent Plugins 1.0.0 Working Draft and the existing Claude-compatible legacy layout.

| Format | Manifest | Skills | Cortex portable MCP |
|---|---|---|---|
| Agent Plugins 1.0 | `plugin.json` at the plugin root | Immediate `skills/<name>/SKILL.md` children | Root `mcp.json` |
| Legacy | `.claude-plugin/plugin.json` | Immediate `skills/<name>/SKILL.md` children | Not cataloged or mapped cross-backend |

A root `plugin.json` takes precedence. If it exists but has a fatal validation error, Cortex reports the portable package as invalid rather than falling back to the legacy manifest. Unknown top-level fields and a non-object `extensions` value are reported and ignored as non-fatal exceptions. The legacy manifest is considered only when root `plugin.json` is absent. The portable format and its failure boundaries follow the [Agent Plugins 1.0.0 specification](https://agent-plugins.org/specification), while Cortex retains the legacy layout for existing installations.

Legacy directories are passed through to the backend. Claude can therefore interpret Claude-native files such as a legacy package's root `.mcp.json`; those servers are not inventoried, summarized, or acknowledgment-gated by Cortex and are not mapped into PI. Use portable root `mcp.json` when MCP must be visible in Settings and consistent across Claude and PI.

## Portable package layout

A portable package has this shape:

```text
my-plugin/
├── plugin.json
├── skills/
│   └── summarize/
│       ├── SKILL.md
│       └── references/
└── mcp.json
```

The minimal manifest selects the exact supported schema:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Summarization skills and tools"
}
```

Cortex validates the manifest with a locally vendored schema and does not fetch schemas while loading a plugin. The package directory name is the Cortex assignment identity; the manifest name supplies the portable runtime namespace. Package files, manifests, skill entry points, plugin-relative commands, and plugin-root-based working directories must remain inside the resolved plugin root. A `${PLUGIN_DATA}` working directory is contained under that plugin's data root instead. A symlink or equivalent path escape is rejected at the narrowest component boundary.

An invalid portable manifest makes the plugin unassignable. An invalid skill is skipped while valid sibling skills remain available. A top-level `mcp.json` error disables MCP for that plugin without disabling valid skills, and an invalid MCP server entry is skipped without removing valid sibling servers. The Plugins page shows these issues instead of silently hiding them.

## Portable MCP servers

A portable `mcp.json` declares stdio, Streamable HTTP, or legacy HTTP+SSE servers. The schema version must match `plugin.json`.

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "local-tools": {
      "type": "stdio",
      "command": "./bin/server",
      "args": ["--data", "${PLUGIN_DATA}"],
      "env": {
        "CONFIG": "${PLUGIN_ROOT}/config.json"
      },
      "cwd": "${PLUGIN_ROOT}"
    },
    "remote-tools": {
      "type": "streamable-http",
      "url": "https://tools.example.com/mcp",
      "headers": {
        "X-Tenant": "public"
      }
    }
  }
}
```

A stdio `command` is one executable token, not a shell command. It can be a bare executable name or a contained `./` path. Cortex expands only `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` in `args`, environment values, and `cwd`; it supplies both variables itself and reserves their names. The dedicated persistent data directory is `$CORTEX_HOME/data/plugin-data/<plugin-id>/` and is created only when a selected stdio server is materialized.

Remote servers require HTTPS except for loopback HTTP. URLs containing credentials or fragments are rejected, and configured headers are never treated as a portable secret mechanism. The PI bridge rejects redirects; Claude receives native supplemental configuration, so its transport owns redirect handling, while the portable contract does not authorize forwarding configured headers to another origin (`agent-server/src/agent-adapter/pi/mcp-bridge.ts:288-300`). The Settings UI shows only the remote origin and header names; for stdio it shows only the executable basename, argument count, and environment key names. Environment and header values are not returned to the browser.

The detailed transport and isolation rules come from the [Agent Plugins MCP runtime contract](https://agent-plugins.org/client-implementers/mcp-runtime). Cortex implements all three declared transports for Claude and PI.

## Assigning plugins

The desktop and browser workbench expose the catalog at **Settings → Plugins**. The page reads the connected Cortex server, so its entries and assignments belong to that server rather than to the local desktop installation. It shows each package's format, manifest metadata, validation state, skills, sanitized MCP summary, and issues.

The target selector covers agent definitions, ordinary template slots, shell bindings, and `__active__` slots. Agent targets store a complete managed plugin set. An ordinary template slot can either use the referenced agent's defaults or customize a complete snapshot. A custom snapshot does not track later agent changes; switching back to agent defaults removes the slot-level `pluginDirs` override. Shell bindings and `__active__` slots are read-only because they do not provide a stable writable assignment location.

Saving uses the entity content hash as an optimistic concurrency guard. If the agent or template changes on disk, Cortex refreshes the target instead of overwriting the newer file. Existing plugin paths that are outside the managed catalog remain preserved and are reported as unmanaged. An already selected invalid catalog entry can be removed, but a new invalid entry cannot be assigned.

Adding a portable plugin with at least one valid root `mcp.json` server opens a confirmation that explains the local-code and network trust surface. The acknowledgment is required for that portable MCP addition, but it is not a sandbox or an independent authorization boundary. Reset discards the local draft, while Save persists it through `plugins.assign`. The Settings modal blocks target navigation and closing while a plugin assignment draft is dirty.

Assignments continue to use `pluginDirs` in the agent and template JSON files. An agent can be configured directly as follows:

```json
{
  "name": "researcher",
  "profile": "claude-sonnet",
  "pluginDirs": [
    "plugins/cortex-common",
    "plugins/my-plugin"
  ]
}
```

A template slot with no `pluginDirs` inherits the referenced agent. A slot object with `pluginDirs` is a complete custom set:

```json
{
  "name": "special-review",
  "agents": [
    {
      "ref": "researcher",
      "pluginDirs": ["plugins/my-plugin"]
    }
  ],
  "transitions": [],
  "entryAgent": "researcher",
  "maxTotalSteps": 4
}
```

Relative paths resolve against `$CORTEX_HOME`; absolute paths remain supported as unmanaged legacy configuration. The Settings UI canonicalizes managed entries to `plugins/<plugin-id>` while preserving unmanaged entries.

## Backend loading

Cortex reloads the selected catalog at spawn time. Legacy plugin directories retain their existing backend path behavior. Portable skills are validated and materialized differently for each backend: Claude receives a private compatibility projection containing a generated manifest and copied, validated skill trees, while PI receives the validated skill directories through repeated `--skill` arguments.

Portable MCP declarations pass through one backend-neutral normalization layer. Claude receives a private supplemental MCP configuration in addition to the normal Cortex MCP layers. PI receives a private content-addressed configuration consumed by the Cortex MCP bridge. PI connects and registers servers independently, so one plugin server failure does not remove bundled Cortex tools, other plugin servers, or skills, and failed servers can retry on a later turn.

A capability fingerprint covers the effective plugin paths, portable skill content, projected manifest, and normalized MCP declarations. Claude pooled sessions reuse a process only when that capability matches, so assignment changes and changes to those covered inputs select a compatible process boundary. Legacy package contents and auxiliary portable files such as executable bytes are not content-hashed; changing only those files does not promise process replacement. Duplicate portable skill names, duplicate portable namespaces, or colliding MCP runtime names fail closed for the selected assignment set.

Portable MCP is suppressed for explicit `none` and benchmark thread-run compositions and for the restricted PI `Agent` subagent surface. This keeps plugin capabilities out of execution modes that intentionally expose a narrower tool set.

## Trust and administration

Everything below `$CORTEX_HOME/plugins/` is administrator-installed code. Assign only packages whose source and contents you trust: a stdio MCP server can execute local code with the backend process's account, and a remote MCP server can receive tool data over the network. Manifest validation, path containment, private runtime files, and assignment confirmation reduce configuration mistakes and secret exposure; they do not sandbox plugin behavior.

The Plugins page manages inventory and assignment only. Its MCP inventory and acknowledgment apply only to portable root `mcp.json`; a legacy Claude-native `.mcp.json` remains outside this managed view. Installation, marketplace search, update, removal, OAuth, credential entry, per-tool permission policy, and live MCP health checks are outside this surface. Installing a package means placing its directory under `$CORTEX_HOME/plugins/` through an administrator-controlled workflow.

## Skill discovery and invocation

The `!skills` command displays discovered skills grouped by plugin. Plugin skills use a plugin-qualified discovery identity such as `cortex-common:synthesize`, while standalone user skills use their bare name. A known bare command at the start of a message can be normalized to its slash form before invocation.

When the `Skill` tool invokes a skill, Cortex's hook bridge records the activity through the session activity tracker. This uses the same access-tracking infrastructure as experiment and knowledge files; [hooks.md](./hooks.md) describes the hook bridge.

## Implementation references

| Behavior | Source |
|---|---|
| Catalog precedence, fixed locations, and narrow validation | `agent-server/src/domain/plugins/catalog.ts:224-390` |
| Portable MCP validation and sanitized summaries | `agent-server/src/domain/plugins/mcp.ts:102-323` |
| Spawn-time projection, normalization, and fingerprinting | `agent-server/src/domain/plugins/runtime.ts:143-559` |
| Agent and template assignment persistence | `agent-server/src/domain/ui-service/mutate/plugins.ts:84-242` |
| Connected-server catalog and target inventory | `agent-server/src/domain/ui-service/query/plugins.ts:32-172` |
| Settings assignment and MCP acknowledgment | `web/src/features/settings/PluginsPanel.tsx:365-800` |
