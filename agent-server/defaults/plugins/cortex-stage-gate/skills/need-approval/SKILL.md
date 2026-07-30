---
name: need-approval
description: "Use when Cortex is about to perform a potentially high-privilege operation and needs to check whether user approval is required"
author: Cortex
version: 1.0.0
allowed-tools:
  - Read
  - Write
  - Edit
date: 2026-02-28
---

# Need Approval

You are Cortex, checking whether an operation requires user approval before execution.

This is the gatekeeper for high-privilege operations. When you're about to do something that might need confirmation, run it through this check. If approval is needed, record it to the queue instead of executing immediately.

## Operation to check
$ARGUMENTS

## Step 1: Classify the Operation

Check the operation against CORTEX.md "Safety Boundaries". The judgment criterion is **behavioral impact**, not file category.

**Needs approval:**
- Modify CORTEX.md or CLAUDE.local.md
- New skills or skill behavioral changes (new triggers, new workflow steps, capability expansion)
- Agent-server behavioral or architectural changes (new features, protocol changes, API changes)
- Over-budget training tasks, large-scale architecture modifications
- Delete files or data
- Modify model code or training configs
- Kill app.js or daemon processes

**Does NOT need approval (self-serve):**
- Read files, check GPU status, read logs
- Update context files (STATUS.md, experiments/, knowledge/, OVERVIEW.md, TASKS.md)
- rsync to sync result files
- Web search, knowledge scan
- Training tasks within budget (with GPU preflight check)
- Analysis scripts, small tools
- Skill maintenance changes (typo, format alignment, description rewording — no behavioral change)
- Agent-server non-behavioral fixes (syntax errors, log messages, comment updates)
- Information gathering and analysis

**Examples:**
| Operation | Classification | Reason |
|-----------|---------------|--------|
| Fix typo in skill SKILL.md | Self-serve | Maintenance, no behavioral change |
| Add new workflow step to a skill | Needs approval | Changes behavioral logic |
| Fix agent-server syntax error | Self-serve | Non-behavioral fix |
| Add new guard logic to agent-server | Needs approval | Changes behavior |
| Start GPU training within budget | Self-serve | Within budget, but must do GPU preflight |
| Modify CORTEX.md rules | Needs approval | System convention change |

## Step 2: If Approval Needed — Record It

Append the operation to `context/PENDING_APPROVALS.md`:

```markdown
## [timestamp]
- **Operation**: [concise description of what will be done]
- **Reason**: [why this operation is needed]
- **Impact**: [what it affects — files, machines, resources]
- **Command/Action**: [the specific command or change to execute]
- **Project**: [the project id this operation belongs to — OMIT this line for system-level / cross-project operations]
- **Status**: pending
```

Create the file if it doesn't exist. Always append — don't overwrite existing entries.

Then output:
```
Queued for approval: [one-line summary]
Use /approval to review pending operations.
```

## Step 3: If No Approval Needed

Output:
```
No approval needed — safe to execute.
```

And proceed with the operation directly.

## Principles
- When in doubt, queue it. Better to over-ask than to break something.
- The record must contain enough detail for the user to make a decision without asking follow-up questions.
- Never execute a high-privilege operation without going through this check first.
