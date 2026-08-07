# Cortex Memory System

Cortex stores all knowledge on the filesystem as atomized, indexed markdown files — the **Dense Context** structure (DR-0007). There is no vector database, no RAG pipeline, and no external knowledge store. The filesystem is the database. For how this fits into the broader system architecture, see [architecture.md](./architecture.md).

## Why Atomized Memory

The core insight (from DR-0007) is that monolithic context files don't scale. A single `EXPERIMENTS.md` file grows unboundedly, making it expensive to load into agent context and hard to search. The solution is to atomize each experiment, knowledge entry, and pattern into its own file, with auto-generated indexes for fast lookup.

This design draws from academic work: Du 2026's survey of agent memory patterns, QMatSuite's layered knowledge hierarchy (finding → pattern → principle), and A-MEM's atomic notes with dynamic linking (< 4μs retrieval time at 1M memories).

## Directory Layout

The knowledge root is `~/.cortex/context/`, structured as follows:

```
context/
├── CORTEX.md                    # Root index — entry point for finding anything
├── OVERVIEW.md                  # Global overview: one-line status per project + last scan date
├── decisions/                   # System-level design decisions (DR-NNNN-title.md)
├── ideas/                       # Incubating research directions
├── scans/                       # Knowledge scan reports, one per date
├── user/                        # User preferences (maintained by /user-learn)
│   └── USER.md                  # Language, style, working habits (< 3KB)
└── projects/                    # One subdirectory per active research project
    └── <project>/
        ├── CORTEX.md            # Project-level index
        ├── mission.md           # Goal and success conditions
        ├── roadmap.md           # Milestones with testable checklist conditions
        ├── STATUS.md            # Present-tense state register (overwriting, max 80 lines / 6KB)
        ├── ISSUES.md            # Execution friction (append-only, resolved items deleted, max 80 lines / 6KB)
        ├── TASKS.yaml           # Structured task queue (machine-readable YAML)
        ├── tasks-archive.md     # Completed tasks archived by the built-in archiver
        ├── experiments/
        │   ├── index.md         # Auto-generated — do not edit manually
        │   └── EXP-NNN.md       # One file per experiment, YAML frontmatter
        ├── knowledge/
        │   ├── index.md         # Auto-generated
        │   └── K-NNN.md         # One file per knowledge entry
        ├── patterns/
        │   ├── index.md         # Auto-generated
        │   └── PAT-NNN.md       # One file per cross-experiment pattern
        ├── decisions/           # Project-level design decisions
        └── _meta/
            └── access-log.jsonl # Auto-tracked Read/Grep access log
```

## The Three Atom Types

### Experiments (EXP-NNN.md)

Each experiment is an atomic file recording a single investigation. An experiment records what was done, what was observed, what was concluded, and what should change going forward.

**YAML frontmatter:**

```yaml
---
id: EXP-042
date: 2026-03-09
project: nimbus
summary: "Initial object registry extraction from 573 artifacts"
tags: [registry, data-analysis, milestone-2.2]
status: valid
executor: Cortex-lab2
links: [PAT-002]
refs: 2
last-ref: "2026-04-16T03:12:21.074Z"
---
```

**Required fields:** `id`, `date`, `project`, `summary`, `tags`.

**Optional fields:** `status`, `executor`, `links` (related entries), `refs` (auto), `last-ref` (auto).

**Body structure:** The markdown body follows a standard template with sections: Background, Execution, Results, Conclusion, and Reflection (goal attainment, unexpected findings, process defects, behavioral adjustments).

**Status lifecycle:**

| Status | Meaning |
|--------|---------|
| `active` | Currently in progress |
| `valid` | Completed, conclusions stand |
| `partial` | Incomplete but worth keeping |
| `challenged` | Conclusions under dispute (tagged with challenging experiment) |
| `corrected` | Conclusions were wrong, now fixed |
| `superseded` | Replaced by a later experiment |
| `refined` | Updated/improved by a later experiment |
| `invalidated` | Proven wrong, tombstoned |
| `stale` | No activity, reference count zero |

### Knowledge Entries (K-NNN.md)

Knowledge entries are atomic facts, anti-patterns, or heuristics distilled from experiments. Each must cite its source experiments in the `evidence` field.

**YAML frontmatter:**

```yaml
---
id: K-008
date: 2026-04-01
project: nimbus
summary: "ANTI-PATTERN: Running smoke tests or broader validation without verifying upstream service availability"
tags: [anti-pattern, smoke-test, service-dependency]
evidence: [EXP-021, EXP-022, EXP-025, EXP-033, EXP-040]
refs: 2
last-ref: "2026-04-10T20:42:00.826Z"
---
```

**Required fields:** `id`, `date`, `project`, `summary`, `tags`, `evidence`.

**Anti-pattern convention:** Knowledge entries describing anti-patterns prefix the summary with `ANTI-PATTERN:` and include `anti-pattern` in tags.

### Patterns (PAT-NNN.md)

Patterns synthesize invariants across multiple experiments. A pattern states a reusable observation that holds across a cluster of experiments.

**YAML frontmatter:**

```yaml
---
id: PAT-001
date: 2026-04-01
project: nimbus
summary: "When a multi-stage pipeline yields zero output, per-stage pass-rate quantification locates the bottleneck faster than end-to-end retries"
tags: [pipeline, diagnosis, stage-isolation]
source-experiments: [EXP-001, EXP-005, EXP-006, EXP-008]
evidence: [EXP-001, EXP-005, EXP-006, EXP-008]
refs: 2
last-ref: "2026-04-16T03:16:28.890Z"
---
```

**Required fields:** `id`, `date`, `project`, `summary`, `tags`, `source-experiments` (the experiments the pattern was extracted from).

**Body structure:** Observation, Evidence (table citing experiments with specific findings), Pattern Statement, Scope & Limitations, Implications.

## Index Auto-Generation

Each directory under a project (`experiments/`, `knowledge/`, `patterns/`) has an `index.md` that is auto-generated by the `memory-index-regen` job. Index files contain the warning:

```
> Auto-generated by memory-index-regen.ts from YAML frontmatter. Do not edit manually.
> Last updated: 2026-05-06T20:31:10
```

**Index structure:**

- **Active table** — all entries with status `active`, `valid`, or `partial`, sorted by reference count (descending)
- **Superseded/Deprecated table** — entries replaced by later work
- **Invalidated table** — tombstoned entries proven wrong
- **Stats section** — total counts, hot entries (refs >= 5), cold entries (refs = 0, age > 14 days)

**Rebuild command:**

```bash
# For all projects
cd agent-server && node --import tsx src/memory-index-regen.ts --all

# For a specific project
cd agent-server && node --import tsx src/memory-index-regen.ts <project-name>
```

The rebuild process reads YAML frontmatter from all atom files, extracts `refs` and `last-ref` from the current index to preserve access tracking, and writes the new index.

## Access Tracking

Cortex automatically tracks which experiment, knowledge, and pattern files are accessed during research. This is implemented as a Claude Code `PostToolUse` hook in `~/.cortex/hooks/memory-ref-tracker.mjs` (see [hooks.md](./hooks.md) for the full hook system).

**How it works:**

1. After every `Read` or `Grep` tool call, the hook checks if the accessed file path matches the pattern `/(experiments|knowledge|patterns)/(EXP-\d+[a-z]?|K-\d+|PAT-\d+)\.md$/`
2. If matched, it extracts the project name from the path and appends a JSON line to `_meta/access-log.jsonl`:
   ```json
   {"file":"EXP-001.md","tool":"Read","ts":"2026-04-02T03:12:21.074Z"}
   ```
3. For `Grep` operations that match multiple files, it parses the tool output to count per-file matches, avoiding duplicate counting
4. If a `Grep` returns zero file matches, it records `_directory_search` instead
5. The hook auto-commits access log changes with message `chore: update access log`

The reference counts (`refs`) in index.md are updated by `memory-index-regen` based on these access logs — a file that is frequently read during research gets a higher reference count and appears higher in the index.

## Project Log Files

Each project has a set of governance files that together form its operational memory:

### mission.md — The Constitution

Defines the project's goal, success conditions, and scope boundaries. This file is stable and should only change with explicit user approval. It answers: what are we trying to achieve, and how will we know we've succeeded?

### roadmap.md — Milestone Map

Layered phases, each containing milestones with testable checklist conditions. Completed milestones are preserved with checkmarks (not deleted). The roadmap shows where the project has been, where it is now, and where it's going.

### STATUS.md — Current Snapshot

An overwriting (not append-only) state register capturing the project's present tense — the minimal state a fresh session needs to continue correctly. Hard-capped at 80 lines and 6KB, with each bullet at most 2 lines. Required sections: current situation, in-flight work & new variables, blockers & pending decisions, next step. Facts that have a durable home elsewhere (experiments, knowledge entries, decision records, task archive) appear only as pointers; the file grows with state complexity, never with project age. Updated when the situation changes — not on every task completion. This is the first file to read when resuming work on a project after a gap.

### ISSUES.md — Execution Friction

An append-only log of problems that slow work, capped at 80 lines and 6KB with each entry at most 4 lines. An entry is a dated title, a one-line symptom, and a one-line root cause with a pointer to the detailed investigation (knowledge entry, task artifact, or experiment record). Resolved issues are deleted from the file (not archived).

### decisions/ — Decision Records

Each decision is one file named `NNNN-title.md`. Format follows the project decision record template: Date, Status, Context, Alternatives (at least 2), Decision, Consequences.

## Dense Context Conventions

The Dense Context system follows these operational conventions:

1. **Every directory has a CORTEX.md index** — describing the directory's purpose, file list, and lookup rules. Indexes are pointer-style (one sentence + pointer per line, one line per atomic directory) and hard-capped at 120 lines and 8KB, matching the context-injection budget
2. **Create file → update index** — when adding a new file to a directory, update that directory's CORTEX.md
3. **Overwrite vs. append** — STATUS.md overwrites (only current state); ISSUES.md appends then deletes; experiments/knowledge/patterns append and stay
4. **Provenance is mandatory** — every factual claim must trace to a specific EXP-NNN, K-NNN, file:line, or inline calculation
5. **Git as persistence** — all context updates are committed via git, incrementally after each logical work unit

## Fresh Session Test

The acid test for Dense Context quality: if you start a fresh session with only read access to the repo, can you learn everything the previous session knew? If the answer is no, something wasn't recorded properly.

## Memory Index Regeneration Job

The built-in memory-index regeneration job rebuilds all index files from YAML frontmatter. `memoryIndexRegenEnabled` and `memoryIndexRegenIntervalMs` in `config/settings.json` control it. The job:

1. Scans all projects under `context/projects/`
2. Reads frontmatter from every `EXP-*.md`, `K-*.md`, and `PAT-*.md`
3. Preserves existing `refs` and `last-ref` from current indexes
4. Writes updated `index.md` files

## Lifecycle: Experiment Maintenance

The `experiment-maintenance` skill runs periodic checks on experiment files:

- Identifies experiments whose conclusions may be stale (based on newer contradictory experiments)
- Flags experiments with zero references and age > 14 days ("cold" entries)
- Checks frontmatter validity
- Suggests consolidation opportunities for related experiments

## Scale

As of the last index rebuild, the system tracks across 9 projects:

| Project | Experiments | Knowledge | Patterns |
|---------|------------|-----------|----------|
| nimbus | 56 | 11 | 4 |
| cortex-self | 66 | 15 | 6 |
| beacon-nav | 27 | ~13 | 2 |
| Other projects | varies | varies | varies |

All indexes are rebuilt simultaneously — the command runs in under a second.
