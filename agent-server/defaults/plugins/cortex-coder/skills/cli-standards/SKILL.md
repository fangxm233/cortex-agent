---
name: cli-standards
description: "Use when designing, implementing, reviewing, or auditing CLI tools. Provides 7 mandatory design rules for all Cortex CLIs (TypeScript and Python). Reference this skill from /develop when building CLI features."
metadata:
  author: "Cortex"
  version: "1.0.0"
  date: "2026-03-29"
---

# CLI Standards

7 mandatory design rules for all Cortex CLI tools. Every CLI — new or modified — must comply.

## Arguments
$ARGUMENTS

If no arguments: audit mode — check all CLIs against the 7 rules.
If arguments describe a specific CLI or feature: apply rules to that context.

---

## The 7 Rules

### Rule 1: Explicit Flags

All key inputs via explicit `--flag` names. No magic positional arguments for non-trivial inputs.

```bash
# Good
cli add --project myproj --text "task" --priority high
cli add --type daily --time 09:00 --message "standup"

# Bad — positional args are ambiguous
cli add myproj "task" high
cli add daily 09:00 "standup"
```

**Exception**: A single primary argument (e.g., `cli get <id>`) is acceptable when the semantics are unambiguous. Legacy positional modes may be kept for backward compatibility alongside flag mode.

### Rule 2: Help with Copyable Examples

Every command and subcommand supports `--help` / `-h`. Help output must include:

1. **Usage line** — synopsis with required/optional args
2. **Command list** — grouped by category if >8 commands
3. **Options** — with defaults shown
4. **Examples** — real, copy-paste-ready commands (not pseudo-syntax)

```
Examples:
  cli query --project nimbus --status actionable --json
  cli complete --project orchard --task-id a3f2 --note "Verified"
  echo '{"subtasks":[...]}' | cli decompose --project myproj --task-id b7c1 --subtasks-file -
```

**Implementation**: Use `cli-utils.ts` `formatHelp()` for TS CLIs. For Python CLIs, use `argparse` with `epilog` + `RawDescriptionHelpFormatter`.

### Rule 3: Stdin / Pipeline Support

Commands that accept file or text input must support `-` (stdin) as an input source.

```bash
# Read from file
cli decompose --subtasks-file tasks.json

# Read from stdin
cat tasks.json | cli decompose --subtasks-file -
echo '{"text":"..."}' | cli add --project myproj --from-stdin
```

**Implementation**: For TS, use `readStdinSync()` from `cli-utils.ts`. For Python, use `sys.stdin.read()`.

**When to add stdin**: Any flag that takes a file path or large text blob should accept `-`. Pure-flag commands (e.g., `claim --task-id X`) don't need stdin.

### Rule 4: Error = Fail Fast + Fix Path

When input is invalid, the error message must:
1. **State what's wrong** — the specific invalid value
2. **List valid alternatives** — so the user can self-correct
3. **Exit non-zero** — `process.exit(1)` / `sys.exit(1)`

```
# Good
Error: Unknown command: 'clam'. Available commands: claim, unclaim, complete, block, ...
Error: Invalid --status: 'actve'. Valid values: actionable, in-progress, completed, blocked, ...

# Bad
Error: invalid arguments
Error: command not found
```

**Implementation**: Use `formatError()` from `cli-utils.ts` (supports `validValues` and `hint` fields). For Python, raise `argparse` errors or print structured messages.

### Rule 5: Idempotency

Retrying the same command must not create side effects (duplicate entries, double state transitions).

| Strategy | When to use |
|----------|-------------|
| **Opt-in key** (`--idempotency-key`) | Create/add operations where content-based dedup is ambiguous |
| **State guard** | State transitions — check current state before mutating (e.g., `claim` on already-claimed task = no-op) |
| **Existence check** | File/directory creation — skip if already exists (unless `--force`) |

```bash
# First call creates the task
cli add --project myproj --text "..." --idempotency-key "session-abc-1"
# Retry returns the cached result without creating a duplicate
cli add --project myproj --text "..." --idempotency-key "session-abc-1"
```

**Implementation**: Use `checkIdempotencyKey()` / `storeIdempotencyKey()` from `cli-utils.ts`. Keys expire after 24h.

### Rule 6: Dry-Run for Dangerous Actions

Commands that delete, kill, or irreversibly mutate must support `--dry-run`.

Dry-run must:
1. Perform all validation and lookups
2. Return what **would** happen as structured JSON (`{ dry_run: true, would_remove: {...} }`)
3. **Not** perform the mutation

```bash
# Preview before killing
cli stop --task-id a3f2 --dry-run
# → { "dry_run": true, "would_stop": { "task_id": "a3f2", "machine": "<machine>", ... } }

# Preview before deleting
cli remove abc123 --dry-run
# → { "dry_run": true, "would_remove": { "id": "abc123", "message": "..." } }
```

**Which commands need dry-run**: `stop`, `remove`, `delete`, `decompose` (rewrites task structure), batch mutations. Read-only commands and simple state transitions (`claim`, `complete`) don't need it.

### Rule 7: Structured Return Data

Success output must be JSON consumable by the next pipeline step.

```bash
# Good — structured, parseable
cli claim --project myproj --task-id a3f2
# → { "ok": true, "task_id": "a3f2", "agent": "cortex-<machine>", "claimed_at": "2026-03-29T..." }

# Bad — human-only text
# → "Task claimed successfully."
```

**Requirements**:
- Always include `ok: true/false` (or equivalent status field)
- Include the entity ID (`task_id`, `schedule_id`, etc.)
- Include state-change details (who, when, what changed)
- Timestamps in ISO 8601

---

## Shared Infrastructure

All TS CLIs in `agent-server/src/` share `cli-utils.ts`:

| Export | Purpose | Rules served |
|--------|---------|-------------|
| `formatHelp(spec)` | Consistent help rendering with groups and examples | Rule 2 |
| `formatError(msg, opts)` | Error with valid values and hints | Rule 4 |
| `readStdinSync()` | Synchronous stdin reading (fd 0) | Rule 3 |
| `checkIdempotencyKey(key)` | Check if key was used in last 24h | Rule 5 |
| `storeIdempotencyKey(key, result)` | Store key + result for dedup | Rule 5 |

When creating a new TS CLI, import from `cli-utils.ts` rather than reimplementing.

---

## Audit Checklist

When reviewing or auditing a CLI, check each rule:

| # | Rule | Check |
|---|------|-------|
| 1 | Explicit flags | No ambiguous positional args for non-trivial inputs? |
| 2 | Help + examples | `--help` works? Examples are real and copyable? |
| 3 | Stdin | File/text inputs accept `-`? |
| 4 | Error fix path | Invalid input shows valid alternatives? Non-zero exit? |
| 5 | Idempotency | Retry-safe? Create ops have dedup mechanism? |
| 6 | Dry-run | Destructive commands support `--dry-run`? |
| 7 | Structured return | Output is JSON with IDs and state details? |

**Compliance rating**: Count passing rules. 7/7 = compliant. <7 = list gaps and create tasks.

---

## Usage Patterns

### From /develop (new CLI feature)

When `/develop` detects CLI work (new subcommand, new CLI tool), reference this skill:

1. Design the flag interface (Rule 1)
2. Add help text with examples (Rule 2)
3. Add stdin support where applicable (Rule 3)
4. Implement error messages with valid values (Rule 4)
5. Add idempotency for create operations (Rule 5)
6. Add `--dry-run` for destructive operations (Rule 6)
7. Return structured JSON (Rule 7)
8. Write tests covering all 7 rules

### From audit mode (no arguments)

1. List all CLI entry points (`*.ts` with `runCli` + `*.py` with `argparse`)
2. For each CLI, check the 7-rule checklist
3. Output a compliance matrix
4. Create tasks for gaps
