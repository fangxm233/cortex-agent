---
name: deep-retrospective
description: Use when reviewing multi-day work across past Claude Code sessions, extracting reusable patterns from historical logs, or asking what was learned about a topic over time.
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, Agent
---

# Deep Retrospective

Mine historical Claude Code conversation logs to extract cross-session knowledge that no
single session could reveal: iterative patterns, recurring bugs, evolving solutions, and
methodology that emerged across multiple work sessions.

## When to Use

- After a multi-day effort (video production, training pipeline, debugging saga)
- When the user says "what did we learn about X over the past few days"
- When you want to generalize a workflow into a skill or knowledge entry based on actual experience
- Periodic review of accumulated work to find patterns worth codifying

## How It Differs From `/compound`

| | compound | deep-retrospective |
|---|---|---|
| **Scope** | Current session only | Multiple sessions across days/weeks |
| **Input** | Conversation context in memory | JSONL log files on disk |
| **Strength** | Captures fresh insights in the moment | Reveals cross-session patterns and evolution |
| **Output** | Knowledge entries (knowledge/K-NNN.md), conventions | Methodology, code templates, workflow skills |
| **When** | End of a productive session | After a multi-day effort completes |

They are complementary: `/compound` captures in the moment, `/deep-retrospective` finds what
emerged across sessions that no single session could see.

## The Process

### Step 1: Scope the Retrospective

Identify:
- **Time range**: which dates to scan (e.g., "March 1-3")
- **Topic**: keywords to filter by (e.g., "video, compose, render")
- **Goal**: what kind of output (knowledge entry (knowledge/K-NNN.md)? skill? code template? methodology doc?)

### Step 2: Scan Logs

Use the bundled scanner to find relevant sessions:

```bash
python3 .claude/skills/deep-retrospective/scripts/scan_logs.py \
  --from 2026-03-01 --to 2026-03-03 \
  --keywords "video,compose,render,wall,grid"
```

This scans all JSONL files in the resolved Claude Code project log directory for the current repo (derived from the project path unless `--log-dir` overrides it), filters by
date range and keywords, and ranks sessions by relevance. Output includes:
- Session IDs and paths
- Size and message count
- Keyword hit counts per session
- Subagent log paths

### Step 3: Extract Conversations

For each relevant session, extract readable conversation:

```bash
python3 .claude/skills/deep-retrospective/scripts/extract_session.py \
  <session_path.jsonl> \
  --keywords "video,render" \
  --context 2 \
  --max-lines 500
```

This converts JSONL into readable `USER/ASST` dialogue with tool call summaries,
filtered to keyword-relevant segments with context windows.

**Subagent scaling**: For ≤5 relevant sessions, process sequentially (one extract call each).
For >5 sessions, launch subagents in parallel — group 2-3 sessions per subagent to balance
parallelism vs overhead. Each subagent extracts keyword-relevant segments and returns a
structured summary.

### Step 4: Analyze Patterns

Read the extracted conversations looking for these cross-session signals:

**Iteration patterns** — The same problem being attacked across multiple sessions:
- Bug fixed, reappeared, fixed differently → the final fix is the knowledge
- Approach tried, failed, replaced → the failure reason + replacement is the knowledge
- Design decision made, then revised → the revision reason is the knowledge

**Workflow evolution** — How the process changed over time:
- Session 1: manual steps → Session 3: automated script → the automation is the knowledge
- Early sessions: lots of trial-and-error → Later: systematic approach → the method is the knowledge

**Recurring friction** — Same class of problem across sessions:
- Name mismatches every time assets are collected → naming convention is the knowledge
- Grid computation bugs in every render iteration → grid math pattern is the knowledge

**User corrections** — Where the user redirected or corrected:
- "That's not why we crop — it's to zoom in on the subject" → corrected understanding is the knowledge
- "Don't hardcode this" → parameterization principle is the knowledge

### Step 5: Synthesize Output

Based on what patterns were found, produce the appropriate output.

**All retrospective reports must be written to `context/retrospectives/`**:
- File naming: `YYYY-MM-DD-<topic>.md` (date = execution date, topic = keyword)
- Update `context/retrospectives/CORTEX.md` index with new entry
- This is the persistent record — even if the output also creates K-entries or skills

**Report structure** (see `context/retrospectives/2026-03-04-video-compose.md` as example):

```markdown
# Retrospective: <Topic>

> Extraction date: YYYY-MM-DD
> Source: Claude Code conversation logs for date range (N sessions, ~X MB)
> Project: <project name>
> Output: <what was produced — K-entries, skills, templates>

## Background
<Why this retrospective was triggered>

## Cross-Session Pattern Discoveries
### Pattern 1: <Pattern name>
<Evidence from logs + extracted knowledge>

### Pattern N: ...

## Outputs
<List of concrete outputs: K-entries added, skills created, templates written>

## Methodology Reflection
<Meta-observations about the retrospective process itself>
```

**Additional outputs** (alongside the report):

**Knowledge entry** (for a single insight):
- Create a new knowledge entry in the relevant project's `knowledge/K-NNN.md`
- Cross-project methodology → create a new entry in `cortex-self/knowledge/K-NNN.md`
- Include: evidence (which sessions), verification date

**Skill** (for a repeatable workflow):
- Create via skill-creator
- Include code templates in `references/` extracted from actual working code
- Generalize: strip project-specific details, keep the battle-tested patterns

**Code templates** (for reusable code patterns):
- Extract the final working version of key functions
- Remove project-specific names/paths, add parameters
- Add comments explaining why each pattern exists (the "why" comes from the iteration history)

### Step 6: Validate and Commit

Before finalizing, cross-check:
- [ ] Every claim traces to a specific session/commit (not invented)
- [ ] Code templates actually come from working code (not theoretical)
- [ ] Generalizations don't lose essential details
- [ ] User corrections are incorporated (not the pre-correction version)
- [ ] Report written to `context/retrospectives/YYYY-MM-DD-<topic>.md`
- [ ] `context/retrospectives/CORTEX.md` index updated
- [ ] Git commit with all changes

## Log File Format

Claude Code stores logs in `~/.claude/projects/<project-slug>/`:

```
<session-uuid>.jsonl           — main conversation log
<session-uuid>/subagents/      — subagent conversation logs
  agent-<id>.jsonl
```

Each JSONL line is a record with:
- `type`: "user" | "assistant" | "queue-operation"
- `message.role`: "user" | "assistant"
- `message.content`: string or array of content blocks
  - `{type: "text", text: "..."}` — conversation text
  - `{type: "tool_use", name: "...", input: {...}}` — tool calls
  - `{type: "tool_result", content: "..."}` — tool outputs
- `timestamp`: ISO 8601
- `sessionId`: UUID

## Tips

- **Start with scan, not grep**: The scanner scores relevance across files. Raw grep
  returns too many false positives from tool outputs and code snippets.
- **Subagents for parallel extraction**: For 5+ sessions, launch one subagent per file.
  Each extracts keywords + context, returns a summary. Much faster than sequential reads.
- **Focus on deltas, not states**: The most valuable knowledge is what *changed* between
  iterations. "We switched from X to Y because Z" is more useful than "we use Y."
- **User corrections are gold**: When the user says "no, that's not right, it's actually..."
  — that correction often reveals the most non-obvious knowledge.
- **Git log supplements JSONL**: `git log --oneline --since="2026-03-01" --until="2026-03-04"`
  shows what was actually committed. Correlate with conversation to understand why.
