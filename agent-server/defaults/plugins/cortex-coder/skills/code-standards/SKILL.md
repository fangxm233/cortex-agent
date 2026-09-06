---
name: code-standards
description: "Use when writing, editing, refactoring, or reviewing code, or when creating CORTEX.md index files for code directories"
metadata:
  author: "Cortex"
  version: "2.0.0"
---

# Code Standards

Any code-related directory (agent-server, plugins, scripts, tools, etc., as well as code subtrees within projects) must satisfy the following three rules. Design goal: **index is only for indexing, file header is only for locating**. Any expanded explanation is a violation.

## Rule 1 — Folder Index CORTEX.md (Hard Limit)

Every folder containing code must have a `CORTEX.md` with the format **strictly as follows**:

```
Please update me when files in this folder change.

<Architecture description, 1-3 lines, each ≤80 characters>

| filename | role | function |
|---|---|---|
| a.ts | entry | Start HTTP service |
| b.ts | core | Dispatch requests to handler |
| c.ts | utility | Read/write TASKS.md |
```

Hard constraints:

- Line 1 **must be** the opening declaration (original text or equivalent, Chinese or English accepted), cannot be omitted.
- Architecture description **1-3 lines**, each ≤80 characters, only state "what this folder does in the system", do not explain principles.
- `role` column ≤10 characters (e.g., "entry", "core", "utility", "type", "adapter").
- `function` column ≤50 characters, only state "what it does", not "how it does it".
- **Total file line count ≤ file count + 7** (1 declaration + 3 architecture + 1 blank + 2 header + N rows = N+7).

**Prohibited** (any one triggers a violation):

- ✗ Any `##` sections (design points/background/usage instructions/FAQ/examples/Todo, etc.)
- ✗ Cross-file reference chains ("see X", "refer to Y")
- ✗ Run commands, CLI parameters, environment variable descriptions
- ✗ Implementation principles, mechanism explanations, technical motivations
- ✗ Task IDs, DR numbers, work progress, timestamps
- ✗ Inline backtick code blocks, lists, multiple sentences in table cells

Need to explain principles? Write in code comments inside the code file. **CORTEX.md only does indexing.**

## Rule 2 — File Header (Strictly 4 Lines)

Each code file must start with **strictly 4 lines**, cannot be added to or expanded:

```
// input:  <depends-on modules/data, list without explanation, ≤60 chars>
// output: <exported symbols/side effects, ≤60 chars>
// pos:    <this file's role in the local context, 1 sentence, ≤60 chars>
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
```

Python / Shell files use `#` instead of `//`.

`pos` definition: **Let someone determine "whether to open this file" in 3 seconds**. Not to explain how it works, why it was designed this way, or what systems it interacts with. Implementation principles, design motivations, mechanism explanations → written in the corresponding function/class comments inside the file, not in the file header.

**Prohibited**:

- ✗ pos written as multi-line layered description ("Communication mechanism: … Hook system: …")
- ✗ input listing a dozen modules (pick 2-4 key ones, omit the rest)
- ✗ Adding extra lines like `// note:` `// history:` `// author:`
- ✗ Written as paragraphs (multiple consecutive lines describing the same thing)

## Rule 3 — Linked Updates

- Modify any code file → check and update the file's 4-line header + the parent folder's CORTEX.md.
- Add/delete files → update the parent folder's CORTEX.md file list table.
- Architecture changes (cross-folder) → update the upper-level CORTEX.md or root CORTEX.md.

## Good / Bad Comparison

### CORTEX.md — Bad (from `agent-server/src/agent-adapter/` old version)

```
# Agent Adapter

DR-0008 Section 3 abstract layer. Decouples the Cortex core from Claude Code's specific implementation.
task `e0b6` Phase 1 stub completed, currently working on Phase 2 skeleton...
(followed by 10+ lines of work log and cross-references)

## Design Points
1. Single entry principle: all callers import ...
2. Type exhaustiveness: ...
```

Violations: No opening declaration, mixed in task IDs/progress, contains `## Design Points` section, no file list table.

### CORTEX.md — Good

```
Please update me when files in this folder change.

Agent abstraction layer: decouples core logic from Claude Code specific implementation.

| filename | role | function |
|---|---|---|
| index.ts | entry | Export AgentAdapter interface |
| claude-code.ts | adapter | Interface with Claude Code SDK |
| types.ts | type | AgentAdapter signature definitions |
```

### File Header — Bad (from `thread-types.ts` old version)

```
// input: thread-manager, hook-registry, ...
// output: Thread, Stage, HookSpec, ...
// pos: Thread system type definitions.
//      Communication mechanism: using AsyncIterable to stream events from stage...
//      Hook system: registration points include pre/post/on-error three types...
//      Abort mechanism: cascading cancellation via AbortSignal...
//      Stages design: each stage has independent context...
//      (9 more lines here)
```

Violation: pos expanded into 13-line layered description, should be only 1 sentence.

### File Header — Good

```
// input:  zod, thread-manager
// output: Thread/Stage/HookSpec types and schema
// pos:    Thread system public type definitions
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
```

Those original "Communication mechanism / Hook system / Abort mechanism" explanations moved to the corresponding type/interface declarations as adjacent comments.

## Code Quality Gates

The following are hard constraints on the code itself (in parallel with index/comment conventions):

| Dimension | Limit | Action |
|---|---|---|
| File length | ≤ 800 lines | Split into multiple modules |
| Function length | ≤ 30 lines | Extract sub-functions |
| Nesting depth | ≤ 3 levels | Use early return / extract function / strategy pattern |
| Branch count | ≤ 3 | Use dispatch map / strategy table / split function |

- New code must satisfy all constraints.
- When modifying existing code, if you encounter non-compliant functions, refactor them to comply.
- Refactoring must not change external behavior (preserve interfaces).
