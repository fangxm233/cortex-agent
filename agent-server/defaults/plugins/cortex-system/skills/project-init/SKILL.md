---
name: project-init
description: "Use when onboarding a new project into Cortex's tracking system, or when asked to initialize or set up context for a project"
author: Cortex
version: 2.0.0
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
  - Agent
date: 2026-03-05
---

# Project Init

You are Cortex, initializing context for a new or existing project. Your job is to scan the project's code and resources (locally and on any registered remote machines), read core documentation to understand what the project does, then generate structured context files so future Cortex sessions can quickly pick up where work left off.

## Project info
$ARGUMENTS

The user should provide: project name, code location (which machine, what path), and optionally a brief description of the project's goal.

If critical info is missing, ask the user before proceeding.

## Step 1: Scan the Project

Inspect the project's code and resources. If multiple machines host parts of the project, use Agent subagents for parallel exploration.

- **Directory structure**: `ls -la`, `tree -L 2` (or equivalent) to understand organization
- **Key files**: README, config files, dependency manifests (requirements.txt / pyproject.toml / package.json / Cargo.toml / go.mod / Makefile), entry-point scripts
- **Git state**: current branch, recent commits (`git log --oneline -10`), remotes
- **Stack**: identify language, framework, runtime, key dependencies
- **Data paths**: where input data, generated artifacts, and outputs live
- **Core documentation**: read README, design docs, or any documentation that explains what the project is about. This is critical for understanding the project's goal and approach.

## Step 2: Create Context Structure

Create the project directory and files under `context/projects/<project-name>/`:

### CORTEX.md (required) — Project index

This is the entry point for future sessions. Must include:
- One-line project description
- Approval rules for any sensitive deliverables (production code, customer-facing docs, etc.)
- File list table (all files in this directory)
- Quick lookup section (what to find where)
- **Project location map**: detailed table of paths on each machine, covering code, data, generated artifacts, docs, results, etc.

```markdown
# <project-name>/ Index

[One-line description]. [Optional: target audience or deliverable].

## File List

| File | Type | Purpose |
|------|------|---------|
| STATUS.md | Overwrite | Present-tense state register (hard cap 80 lines AND 6KB) |
| experiments/ | Atomic file | One EXP-NNN.md per experiment (YAML frontmatter + body), index.md auto-generated |
| knowledge/ | Atomic file | One K-NNN.md per knowledge entry, index.md auto-generated |
| patterns/ | Atomic file | Cross-experiment patterns, index.md auto-generated |
| _meta/ | Auto | access-log.jsonl (hook tracks access records) |
| mission.md | Stable | Goals and success conditions |

## Quick Lookup

- [topic] → `[file]` § [section]
- ...

## Project Component Locations

### [machine1] (`ssh ...`)

| Path | Content | Description |
|------|---------|-------------|
| ... | ... | ... |

### [machine2] (`ssh ...`)

| Path | Content | Description |
|------|---------|-------------|
| ... | ... | ... |
```

### STATUS.md (required) — Current state snapshot

Format is governed by `rules/status-md.md` (overwrite-style state register, hard cap 80 lines AND 6KB, each bullet <=2 lines, facts with a durable home appear as pointers only):

```markdown
# [Project Name] Status

Updated: YYYY-MM-DD

## Current Situation
<One paragraph: position on the roadmap + core focus + one-sentence situation call>

## In Flight & New Variables
<<=5 items, each <=2 lines + pointer (task-id / EXP-NNN / commit). Write "none" if empty>

## Blockers & Pending Decisions
<External blockers, decisions awaiting the user. Write "none" if empty>

## Next Step
<The concrete next action, pointing to a TASKS.yaml task-id or a plan file>
```

### experiments/ (required) — Experiment records (atomized, DR-0007)

Create the `experiments/` directory. If the project has existing experiments, create individual `EXP-NNN.md` files with YAML frontmatter (see `.claude/rules/experiment-format.md` for format). Otherwise create an empty directory. Run `cd agent-server && node --import tsx src/memory-index-regen.ts <project>` to generate `index.md`.

### knowledge/ (required) — Technical knowledge (atomized, DR-0007)

Create the `knowledge/` directory. Capture technical details as individual `K-NNN.md` files with YAML frontmatter:
- Architecture details (modules, interfaces, data flow)
- Data format (directory structure, file types, schema)
- Runtime / deployment flow (communication protocols, ports, services)
- Configuration (config files, env vars, key parameters)
- Environment setup (runtime, key dependencies)
- Known pitfalls or quirks

### patterns/ and _meta/ (required) — Supporting dirs

Create empty `patterns/` directory and `_meta/` directory with empty `access-log.jsonl`.

### mission.md (required) — Goal and success criteria

Draft from README, design doc, or user description. Mark as draft for user review.

### roadmap.md (optional) — Only if clear milestones exist

Skip for projects already in late-stage delivery. Create only when the project has clear future milestones with testable verification conditions.

## Step 3: Update Indexes

1. Add the project to `context/projects/CORTEX.md` project list table
2. Add the project to `context/OVERVIEW.md`

## Step 4: Commit

```
git add context/projects/<project-name>/ context/projects/CORTEX.md context/OVERVIEW.md
git commit -m "project-init: add <project-name> (<brief description>)"
```

## Step 5: Report

Output a structured summary:
- What the project is about (from README / docs)
- Location map (which machine has what)
- Key technical details (architecture, data, current state)
- Files created

## Principles

- **Read the README and core docs first** — understanding the project is prerequisite to useful context files
- CORTEX.md is the most important file — it's the entry point for all future sessions
- Location map must be exhaustive — every relevant path on every machine
- Auto-generated content is clearly marked — the user owns the final version
- mission.md is a draft until the user confirms
- If the project directory already has context files, warn the user instead of overwriting
- If SSH fails or a path doesn't exist, report the failure clearly
