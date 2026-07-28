# Cortex Skills and Plugins

The skill system lets Cortex agents load specialized capabilities on demand. Skills are packaged into **plugins** — role-scoped bundles that group related skills together. When an agent runs, its plugin directories are loaded, and the skills within become available as invocable tools.

## What Is a Skill

A skill is a markdown file (`SKILL.md`) that instructs the agent how to perform a specific task. Skills are invoked by typing `/<skill-name>` in chat, or they can be auto-triggered when the agent's context matches the skill's description.

A skill consists of:

1. **YAML frontmatter** — metadata: name, description (trigger condition), allowed tools
2. **Markdown body** — the prompt that gets expanded when the skill is invoked

### SKILL.md Format

```yaml
---
name: synthesize
description: "Use when multiple experiments or analyses have accumulated and their findings need to be interpreted together — cross-experiment patterns, contradictions, and gaps"
allowed-tools:
  - Read
  - Grep
  - Glob
  - Write
argument-hint: "[project name, time range, topic, or file paths]"
---

# /synthesize <scope>

## Purpose
...
```

**Frontmatter fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Lowercase skill identifier (must match directory name) |
| `description` | Yes | **Trigger condition only** — "when should this skill be invoked?" Not a summary of what it does |
| `allowed-tools` | No | List of tools this skill can use. If omitted, the skill can use all tools |
| `argument-hint` | No | CLI argument hint shown to the user |
| `author` | No | Skill author |
| `version` | No | Semantic version |
| `date` | No | Last update date |

**Critical rule for descriptions:** The description must state only the trigger condition, not the workflow. For example:

- Good: "Use when multiple experiments or analyses have accumulated and their findings need to be interpreted together"
- Bad: "Synthesizes findings from multiple experiments into unified conclusions" (this describes what the skill does, not when to use it)

## Plugin Architecture

### Directory Layout

Skills are organized into plugins under `~/.cortex/plugins/`:

```
plugins/
├── cortex-common/              # 14 skills: cross-role primitives
│   ├── .claude-plugin/
│   │   └── plugin.json
│   └── skills/
│       ├── synthesize/SKILL.md
│       ├── critique/SKILL.md
│       ├── claudeception/SKILL.md
│       ├── diagnose/SKILL.md
│       ├── debug-campaign/SKILL.md
│       ├── experiment-review/SKILL.md
│       ├── audit-references/SKILL.md
│       ├── postmortem/SKILL.md
│       ├── research-framing/SKILL.md
│       ├── solution-design/SKILL.md
│       ├── compound/SKILL.md
│       ├── compound-simple/SKILL.md
│       └── ...
├── cortex-coder/               # 3 skills: code development
│   ├── .claude-plugin/plugin.json
│   └── skills/
│       ├── develop/SKILL.md
│       ├── code-standards/SKILL.md
│       └── cli-standards/SKILL.md
├── cortex-system/              # 18 skills: system operations
├── cortex-stage-gate/          # 3 skills: project governance
├── cortex-surveyor/            # 2 skills: literature research
├── cortex-designer/            # 1 skill: experiment design
├── cortex-analyst/             # 1 skill: knowledge refinement
└── cortex-writer/              # 2 skills: paper writing
```

Each plugin has a `.claude-plugin/plugin.json` for metadata:

```json
{
  "name": "cortex-common",
  "version": "0.1.0",
  "description": "Cortex cross-role skill bundle — critique / audit / diagnosis / synthesis / design / debug primitives shared by multiple research-pipeline agents"
}
```

### The Eight Built-in Plugins

| Plugin | Role | Skills | Purpose |
|--------|------|--------|---------|
| `cortex-common` | Cross-role | 14 | Critique, audit, diagnosis, synthesis, experiment review, research framing, solution design, postmortem, debug campaign, compound, claudeception |
| `cortex-coder` | Coder | 3 | TDD development (`develop`), code standards, CLI standards |
| `cortex-system` | System | 18 | Orient, evolve, schedule, thread management, project init, user learn, feedback, gravity, approval, experiment maintenance, deep retrospective, video tools, client management, refresh-skills |
| `cortex-stage-gate` | Stage gate | 3 | Task management, need-approval, reorient |
| `cortex-surveyor` | Surveyor | 2 | Literature review, horizon scan |
| `cortex-designer` | Designer | 1 | Research probe design |
| `cortex-analyst` | Analyst | 1 | Knowledge refinement and contradiction resolution |
| `cortex-writer` | Writer | 2 | CS academic writing, PDF generation |

## How Skills Are Loaded

### Per-Agent Plugin Configuration

Each agent definition in `thread-templates.json` specifies its plugins via the `pluginDirs` field (see [threads.md](./threads.md) for the full thread template system):

```json
{
  "agents": {
    "researcher": {
      "profile": "claude-sonnet",
      "pluginDirs": [
        "plugins/cortex-common",
        "plugins/cortex-surveyor"
      ]
    },
    "coder": {
      "profile": "claude-sonnet",
      "pluginDirs": [
        "plugins/cortex-common",
        "plugins/cortex-coder"
      ]
    }
  }
}
```

Relative paths are resolved against `DATA_DIR` (default: `~/.cortex/`). Absolute paths are used as-is.

### Template-Level Overrides

Templates can override an agent's plugin set:

```json
{
  "templates": {
    "special-review": {
      "agents": [
        {"ref": "coder", "pluginDirs": ["plugins/cortex-coder", "plugins/cortex-analyst"]}
      ]
    }
  }
}
```

### Backend Integration

Plugins are passed to the LLM backend at spawn time:

- **Claude Code**: `--plugin-dir <path>` flags
- **PI**: `--skill <path>` flags

The backend itself handles scanning the directories for `SKILL.md` files and making them available via the `Skill` tool.

## Skill Discovery

Cortex scans multiple roots for `SKILL.md` files:

1. `{DATA_DIR}/plugins/` — the main plugin directory (organized by plugin name)
2. `{DATA_DIR}/.claude/skills/` — user-modifiable skills root

Discovery is recursive: any subdirectory containing a `SKILL.md` is treated as a skill. Results are cached with a 60-second TTL.

### Skill Namespacing

Skills discovered under `plugins/<name>/skills/<skill>/SKILL.md` are namespaced as `plugin:skill` (e.g., `cortex-common:synthesize`). Skills in the user skills directory `.claude/skills/<name>/SKILL.md` use bare names (e.g., `synthesize`).

### Command Normalization

If a user types a message that starts with a known skill name (without the `/` prefix), the message router automatically prepends `/` to ensure it's treated as a skill invocation. For example, typing `synthesize nimbus` in chat is normalized to `/synthesize nimbus`.

## The `!skills` Command

Running `!skills` in Slack displays all available skills grouped by plugin:

```
*Available skills*
_cortex-common_
• `audit-references` — Verify cited references before committing artifacts
• `claudeception` — Extract reusable knowledge from work sessions
• `compound` — Embed accumulated findings into conventions and skills
...

_cortex-coder_
• `cli-standards` — 7 mandatory CLI design rules
• `code-standards` — Code directory CORTEX.md conventions
• `develop` — TDD-first development workflow
...
```

## Creating a New Skill

Use the `skill-creator` skill to create new skills. The general process:

1. **Identify the need**: What recurring task pattern needs a skill?
2. **Determine the plugin**: Which role does the skill serve? Skills used by 2+ templates go in `cortex-common`. Single-template skills go in the corresponding role plugin. System-level skills go in `cortex-system`.
3. **Write SKILL.md**: Create `<plugin>/skills/<name>/SKILL.md` with proper frontmatter and body
4. **Test**: Run an agent with the plugin loaded and invoke the skill

### Skill Safety Boundary

Cortex's safety rules distinguish between maintenance changes and behavioral changes to skills:

- **Autonomous**: Fixing typos, aligning formatting, updating descriptions (no behavioral change)
- **Requires approval**: Adding new trigger conditions, new workflow steps, capability extensions

This distinction is based on behavioral impact, not file category. Fixing a typo in a SKILL.md is safe; adding a new workflow stage requires user confirmation.

## Third-Party Plugin Authoring

Plugins follow a standard structure:

```
my-plugin/
├── .claude-plugin/
│   └── plugin.json          # { "name": "my-plugin", "version": "1.0.0", "description": "..." }
└── skills/
    └── my-skill/
        └── SKILL.md         # YAML frontmatter + markdown body
```

To use a third-party plugin:

1. Place the plugin directory under `~/.cortex/plugins/`
2. Reference it in an agent's `pluginDirs`: `"plugins/my-plugin"`
3. The skill will be available to that agent as `my-plugin:my-skill`

## Hook Bridge and Skill Activity

When a skill is invoked via the `Skill` tool, Cortex's hook bridge records the activity via the `session-activity-tracker.mjs` PostToolUse hook. This enables tracking which skills are used during research sessions — the same access logging infrastructure used for experiment and knowledge files. See [hooks.md](./hooks.md) for details on the hook-bridge and PostToolUse hook system.
