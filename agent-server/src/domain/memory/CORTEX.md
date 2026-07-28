Please update me when files in this folder change

Memory domain: keeps project knowledge indexes current and supplies context sources to agent sessions.
Covers experiment and knowledge indexes, CORTEX.md chains, rule files, skills, and the user profile.

| filename | role | function |
|---|---|---|
| consolidate.ts | core | Detects stale and redundant knowledge entries |
| cortex-md-injector.ts | core | Tracks which CORTEX.md files were injected |
| cortex-md-scanner.ts | util | Collects CORTEX.md files above a target path |
| index-regen.ts | core | Regenerates memory index.md and refs counters |
| rules-loader.ts | util | Loads global and path-scoped rule files |
| skill-scanner.ts | util | Discovers user and plugin skills and command names |
| user-context.ts | util | Loads the user profile for conversation turns |
| watcher.ts | core | Rebuilds memory indexes when files change |
