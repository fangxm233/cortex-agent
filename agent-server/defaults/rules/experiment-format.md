---
paths:
  - "context/projects/*/experiments/**"
  - "context/projects/*/knowledge/**"
  - "context/projects/*/patterns/**"
---

# Atomic Memory File Format Specification (DR-0007)

Experiment, knowledge, and pattern entries have been migrated from a single monolithic file to an atomic structure with one file per entry.

## Size Constraints (new writes only; existing entries are immutable provenance records, never rewritten retroactively)

- **`summary` field <=300 characters, single line**. Its only purpose is one row in the index.md table; an oversized summary poisons the auto-generated index. Anything that doesn't fit goes in the body.
- **EXP body soft limit 400 lines / 24KB**. Raw logs, per-item data, and large tables go to evidence/artifact files with pointers in the body — value traceability already requires naming the producing script + data file; the body carries background/goal/key results/conclusion/reflection.
- **K / PAT body soft limit 150 lines / 8KB**. A knowledge entry is a conclusion + evidence pointers (`evidence` field), never longer than its source experiments; argumentation detail stays in the source EXPs.
- Soft limits do not block writes, but review (reviewer/manager acceptance) should treat exceeding them as a signal: raw dumps may have leaked into memory files.

## Directory Structure

```
context/projects/<project>/
  experiments/
    index.md           # Auto-generated (memory-index-regen), do not manually edit
    EXP-001.md ~ EXP-NNN.md
  knowledge/
    index.md           # Auto-generated
    K-001.md ~ K-NNN.md
  patterns/
    index.md           # Auto-generated
    PAT-001.md ~ PAT-NNN.md
  _meta/
    access-log.jsonl   # Hook auto-tracked Read/Grep access records
```

## Atomic File Format

Each file consists of YAML frontmatter + body content.

### Experiment File (EXP-NNN.md)

```markdown
---
id: EXP-042
date: 2026-03-23
project: <project-name>
summary: "Variant B reduces p99 latency 28% — new project best"
tags: [latency, optimization, variant-b, phase2]
status: valid
executor: "Cortex"
links: []
refs: 0
last-ref: null
---

### EXP-042: Variant B Latency Sweep

#### Background
<Why this experiment was done>

#### Goal
<What to verify>

#### Run Command (optional)
<The actual executed command>

#### Results
<Objective data and observations>

#### Conclusion
<Judgment based on results>

#### Reflection
- **Relationship to existing knowledge**: ...
- **New knowledge**: ...
- **Process defects**: ...
- **Suggested follow-up**: ...
```

### Knowledge File (K-NNN.md)

```markdown
---
id: K-005
date: 2026-03-15
project: <project-name>
summary: "Connection pool size 32 is the optimal range under our peak load"
tags: [pool-size, performance]
evidence: [EXP-022, EXP-037, EXP-041, EXP-042]
refs: 3
last-ref: 2026-03-23
---

## K-005: Connection Pool Size Optimal Range

<Knowledge entry body content>
```

Anti-pattern type knowledge entries have summaries prefixed with `ANTI-PATTERN:`, and tags containing `anti-pattern`.

### Pattern File (PAT-NNN.md)

Cross-experiment patterns distilled from multiple experiments. Must include `source-experiments` and `evidence` fields for traceability.

```markdown
---
id: PAT-001
date: 2026-03-29
project: <project-name>
summary: "Tasks with high I/O concurrency consistently benefit from a connection-pool warm-up step"
tags: [pool-size, warm-up, performance]
source-experiments: [EXP-031, EXP-035, EXP-038]
evidence: [EXP-031, EXP-035, EXP-038]
refs: 0
last-ref: null
---

## PAT-001: <Title>

### Observation / Evidence / Pattern Statement / Scope & Limitations / Implications
```

## Knowledge State Machine (Knowledge Lifecycle)

All entries share a unified `status` state:

| Status | Meaning | In index.md |
|--------|---------|-------------|
| `active` / `valid` / `partial` / empty | Normal, valid | Active table |
| `challenged:EXP-XXX` | Questioned by new experiment, pending review | Active table (annotated) |
| `corrected:EXP-XXX` | Conclusion has been corrected | Active table |
| `superseded:EXP-XXX` | Replaced by a better version | Superseded table |
| `refined:EXP-XXX` | Fully replaced by an improved version | Superseded table |
| `invalidated:EXP-XXX` | **Has been falsified** | Invalidated table (warning) |
| `stale` | No references for a long time, pending review | Superseded table |

`invalidated` entries are replaced with a tombstone (retain frontmatter, replace body with a warning) to prevent subsequent sessions from using incorrect knowledge.

## Frontmatter Field Descriptions

| Field | Required | Description |
|-------|----------|-------------|
| `id` | ✅ | Unique identifier: EXP-NNN / K-NNN / PAT-NNN |
| `date` | ✅ | Creation date YYYY-MM-DD |
| `project` | ✅ | Project name |
| `summary` | ✅ | One-line summary, **<=300 characters** (for index.md table) |
| `tags` | ✅ | Tags array |
| `status` | Recommended | See the state machine table above |
| `executor` | Optional for experiments | Executor |
| `links` | Optional | Related entry IDs |
| `evidence` | Recommended for K/PAT | List of experiment IDs supporting this conclusion (traceability) |
| `source-experiments` | Required for PAT | Source experiments that this pattern was derived from |
| `refs` | Auto | Reference count (computed by memory-index-regen) |
| `last-ref` | Auto | Last reference time |
| `invalidated-date` | Auto | Date of falsification (invalidated entries only) |
| `invalidated-reason` | Auto | Reason for falsification (invalidated entries only) |

## New Experiment Workflow

1. Determine the next EXP number (check the maximum number in the experiments/ directory +1)
2. Create `experiments/EXP-NNN.md`, write frontmatter + body
3. Check if old experiment conclusions are overthrown/corrected, if so:
   - Update the old experiment file's `status` field (`superseded:EXP-XXX` or `refined:EXP-XXX`)
   - Append `#### Downstream Impact` analysis at the end of the new experiment
   - Check if the overturned experiment is referenced by K/PAT entries (grep `evidence` field), if so mark as `challenged`
4. **No need to manually update index.md** — the index is automatically rebuilt by `memory-index-regen.ts`

## New Knowledge/Pattern Workflow

1. Determine the next K/PAT number
2. Create the file, **must include `evidence` field** listing supporting experiments
3. If the content is derived from multiple experiments, ensure `source-experiments` is filled in
