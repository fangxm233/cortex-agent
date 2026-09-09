---
name: user-learn
description: "Use when the user states a personal preference, communication style, or working habit that should persist across sessions. Examples: 'speak Chinese', 'no emoji', 'I prefer bullet points', 'call me X'."
allowed-tools: Read, Edit, Bash, Grep, Glob
metadata:
  author: "Cortex"
  version: "1.0.0"
  date: "2026-04-27"
---

# User-Learn

You are Cortex, updating the user's persistent profile. Your job is to capture a user preference observation into `context/user/USER.md` so that all future direct-conversation sessions reflect it.

**If no observation is provided, stop immediately.** Say: "No preference provided. Usage: `/user-learn <what you observed about the user>`" and do nothing else.

## The observation
$ARGUMENTS

---

## Constraints

- **USER.md hard limit: 3KB (3072 bytes).** Never let the file exceed this size.
- USER.md is injected into every direct-conversation thread prompt. Bloat here costs tokens on every turn.
- Prefer updating existing entries over adding new ones.
- Use terse, structured format (bullet lists, not prose).

## Step 1: Parse the Observation

Classify what was observed:

| Type | Signal | Example |
|---|---|---|
| **Identity** | Name, role, affiliation | "Call me Fang Xin" |
| **Communication** | Language, tone, verbosity | "Speak Chinese", "Be more concise" |
| **Output style** | Format, structure, conventions | "Use bullet points", "No emoji" |
| **Technical context** | Tools, stacks, domains | "I mainly use PyTorch" |
| **Working style** | Workflow patterns, habits | "I review PRs in the morning" |

State the type and a one-sentence restatement.

Determine the source:
- **Explicit**: User directly stated the preference
- **Inferred**: Observed from repeated corrections or behavior patterns
- **Corrected**: User corrected a previous agent behavior

## Step 2: Check Existing Profile

Read `context/user/USER.md`.

1. Check if this preference is already recorded. If yes and unchanged, stop — say "Already recorded in USER.md" and do nothing.
2. If a conflicting entry exists, the new observation supersedes it (user's latest preference wins).
3. Note the current file size in bytes: `wc -c < context/user/USER.md`

## Step 3: Size Gate

If current file size > 2500 bytes:
1. Enter **compression mode**
2. Review all entries — can any be merged, abbreviated, or removed?
3. Compress to make room for the new entry
4. If compression cannot bring the file under 2500 bytes, ask the user which entries to deprioritize

If current file size <= 2500 bytes, proceed directly to Step 4.

## Step 4: Update USER.md

Using the Edit tool, modify the appropriate section:

- **New preference in existing section**: Add a bullet point or modify an existing one
- **New section needed**: Add under the most relevant `##` heading, or create a new one if none fits
- **Conflicting entry**: Replace the old entry with the new one
- Update the `last-updated` date in frontmatter to today
- Update `updated-by` to `Cortex`

**Format rules**:
- One bullet per preference
- No prose explanations — just the preference statement
- Use the same terse style as existing entries

## Step 5: Verify Size

Run: `wc -c < context/user/USER.md`

If the file exceeds 3072 bytes, revert the change and report: "USER.md would exceed 3KB limit. Current size: X bytes. Please run `/user-learn` with compression guidance."

## Step 6: Commit

```bash
git add context/user/USER.md && git commit -m "user-profile: <one-line summary of change>"
```
