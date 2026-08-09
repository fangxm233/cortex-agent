Please update me when files in this folder change.

Plugin catalog and spawn runtime for skills, MCP, and backend projections.

| filename | role | function |
|---|---|---|
| agent-plugins-v1.ts | schema | Define Agent Plugins v1 Zod schemas |
| catalog-types.ts | type | Define catalog DTOs and MCP runtime carriers |
| catalog.ts | core | Load entries and validate portable skill trees |
| fs-helpers.ts | util | Guard plugin path containment and child listing |
| mcp.ts | core | Load MCP views and attach private runtimes |
| native-name.ts | util | Build safe native plugin names |
| runtime.ts | core | Isolate projected skills and MCP runtimes |
| resources/ | asset | Store Agent Plugins 1.0.0 schema files |
| skill-projection.ts | core | Snapshot and verify private skill copies |
| skill.ts | core | Validate skill frontmatter and file loading |
