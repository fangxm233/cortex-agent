Please update me when files in this folder change.

Plugin catalog code: load plugin manifests, skills, and MCP views.

| filename | role | function |
|---|---|---|
| agent-plugins-v1.ts | schema | Define Agent Plugins v1 Zod schemas |
| catalog-types.ts | type | Define catalog DTOs and MCP runtime carriers |
| catalog.ts | core | Load plugin entries with isolated failures |
| fs-helpers.ts | util | Guard plugin path containment and child listing |
| mcp.ts | core | Load MCP views and attach private runtimes |
| resources/ | asset | Store Agent Plugins 1.0.0 schema files |
| skill.ts | core | Validate skill frontmatter and file loading |
