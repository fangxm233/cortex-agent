# Cortex 技能和插件


技能系统让 Cortex 智能体按需加载专用能力。技能被包装成**插件**——将相关技能组合在一起的角色限定包。当智能体运行时，其插件目录被加载，其中包含的技能成为可调用的工具。

## 什么是技能

技能是一个 markdown 文件（`SKILL.md`），指导智能体如何执行特定任务。技能通过在聊天中输入 `/<skill-name>` 来调用，或者当智能体的上下文匹配技能描述时自动触发。

技能由以下组成：

1. **YAML frontmatter** — 元数据：name、description（触发条件）、allowed tools
2. **Markdown 正文** — 调用技能时展开的提示

### SKILL.md 格式

```yaml
---
name: synthesize
description: "当多个实验或分析积累起来，需要一起解读它们的发现时使用——跨实验模式、矛盾和差距"
allowed-tools:
  - Read
  - Grep
  - Glob
  - Write
argument-hint: "[项目名称、时间范围、主题或文件路径]"
---

# /synthesize <scope>

## Purpose
...
```

**Frontmatter 字段：**

| 字段 | 必需 | 描述 |
|-------|----------|-------------|
| `name` | 是 | 小写技能标识符（必须匹配目录名称） |
| `description` | 是 | **仅触发条件**——"何时应调用此技能？"不是它做什么的摘要 |
| `allowed-tools` | 否 | 此技能可以使用的工具列表。如果省略，技能可以使用所有工具 |
| `argument-hint` | 否 | 向用户显示的 CLI 参数提示 |
| `author` | 否 | 技能作者 |
| `version` | 否 | 语义版本 |
| `date` | 否 | 最后更新日期 |

**描述的关键规则：** 描述必须仅说明触发条件，而不是工作流程。例如：

- 好："当多个实验或分析积累起来，需要一起解读它们的发现时使用"
- 坏："将多个实验的发现综合为统一结论"（这描述了技能做什么，而不是何时使用）

## 插件架构

### 目录布局

技能组织在 `~/.cortex/plugins/` 下的插件中：

```
plugins/
├── cortex-common/              # 14 个技能：跨角色原语
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
├── cortex-coder/               # 3 个技能：代码开发
│   ├── .claude-plugin/plugin.json
│   └── skills/
│       ├── develop/SKILL.md
│       ├── code-standards/SKILL.md
│       └── cli-standards/SKILL.md
├── cortex-system/              # 18 个技能：系统操作
├── cortex-stage-gate/          # 3 个技能：项目治理
├── cortex-surveyor/            # 2 个技能：文献研究
├── cortex-designer/            # 1 个技能：实验设计
├── cortex-analyst/             # 1 个技能：知识精炼
└── cortex-writer/              # 2 个技能：论文写作
```

每个插件有一个 `.claude-plugin/plugin.json` 用于元数据：

```json
{
  "name": "cortex-common",
  "version": "0.1.0",
  "description": "Cortex 跨角色技能包——多个研究管道智能体共享的 critique / audit / diagnosis / synthesis / design / debug 原语"
}
```

### 八个内置插件

| 插件 | 角色 | 技能数 | 用途 |
|--------|------|--------|---------|
| `cortex-common` | 跨角色 | 14 | 批判、审计、诊断、综合、实验审查、研究框架、方案设计、事后分析、调试战役、复合、claudeception |
| `cortex-coder` | Coder | 3 | TDD 开发（`develop`）、代码标准、CLI 标准 |
| `cortex-system` | System | 18 | 定位、进化、调度、线程管理、项目初始化、用户学习、反馈、重力、审批、实验维护、深度回顾、视频工具、客户端管理、refresh-skills |
| `cortex-stage-gate` | Stage gate | 3 | 任务管理、need-approval、reorient |
| `cortex-surveyor` | Surveyor | 2 | 文献综述、视野扫描 |
| `cortex-designer` | Designer | 1 | 研究探针设计 |
| `cortex-analyst` | Analyst | 1 | 知识精炼和矛盾解决 |
| `cortex-writer` | Writer | 2 | CS 学术写作、PDF 生成 |

## 技能如何加载

### 每智能体插件配置

`thread-templates.json` 中的每个智能体定义通过 `pluginDirs` 字段指定其插件（完整线程模板系统参见 [threads.md](./threads.md)）：

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

相对路径相对于 `DATA_DIR`（默认：`~/.cortex/`）解析。绝对路径按原样使用。

### 模板级覆盖

模板可以覆盖智能体的插件集：

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

### 后端集成

插件在生成时传递给 LLM 后端：

- **Claude Code**：`--plugin-dir <path>` 标志
- **PI**：`--skill <path>` 标志

后端本身处理扫描目录中的 `SKILL.md` 文件并通过 `Skill` 工具使其可用。

## 技能发现

Cortex 扫描多个根目录以查找 `SKILL.md` 文件：

1. `{DATA_DIR}/plugins/` — 主插件目录（按插件名称组织）
2. `{DATA_DIR}/.claude/skills/` — 用户可修改的技能根目录

发现是递归的：任何包含 `SKILL.md` 的子目录都被视为技能。结果缓存有 60 秒 TTL。

### 技能命名空间

在 `plugins/<name>/skills/<skill>/SKILL.md` 下发现的技能被命名为 `plugin:skill`（如 `cortex-common:synthesize`）。用户技能目录 `.claude/skills/<name>/SKILL.md` 中的技能使用裸名称（如 `synthesize`）。

### 命令标准化

如果用户输入的消息以已知技能名称开头（不带 `/` 前缀），消息路由器自动在前面加上 `/` 以确保它被视为技能调用。例如，在聊天中输入 `synthesize nimbus` 会被标准化为 `/synthesize nimbus`。

## `!skills` 命令

在 Slack 中运行 `!skills` 会按插件分组显示所有可用技能：

```
*Available skills*
_cortex-common_
• `audit-references` — 在提交产物之前验证引用的参考文献
• `claudeception` — 从工作会话中提取可重用知识
• `compound` — 将积累的发现嵌入约定和技能
...

_cortex-coder_
• `cli-standards` — 7 条强制性 CLI 设计规则
• `code-standards` — 代码目录 CORTEX.md 约定
• `develop` — TDD 优先的开发工作流程
...
```

## 创建新技能

使用 `skill-creator` 技能创建新技能。一般流程：

1. **识别需求**：什么重复的任务模式需要一个技能？
2. **确定插件**：该技能服务于哪个角色？被 2 个以上模板使用的技能放入 `cortex-common`。单模板技能放入相应的角色插件。系统级技能放入 `cortex-system`。
3. **编写 SKILL.md**：创建 `<plugin>/skills/<name>/SKILL.md`，包含适当的 frontmatter 和正文
4. **测试**：运行加载了该插件的智能体并调用该技能

### 技能安全边界

Cortex 的安全规则区分技能的维护性更改和行为性更改：

- **自主执行**：修正拼写错误、对齐格式、更新描述（不改变行为）
- **需要审批**：添加新触发条件、新工作流步骤、能力扩展

此区分基于行为影响，而非文件类别。修正 SKILL.md 中的拼写错误是安全的；添加新工作流阶段需要用户确认。

## 第三方插件创作

插件遵循标准结构：

```
my-plugin/
├── .claude-plugin/
│   └── plugin.json          # { "name": "my-plugin", "version": "1.0.0", "description": "..." }
└── skills/
    └── my-skill/
        └── SKILL.md         # YAML frontmatter + markdown 正文
```

要使用第三方插件：

1. 将插件目录放在 `~/.cortex/plugins/` 下
2. 在智能体的 `pluginDirs` 中引用它：`"plugins/my-plugin"`
3. 该技能将作为 `my-plugin:my-skill` 对该智能体可用

## 钩子桥接和技能活动

当通过 `Skill` 工具调用技能时，Cortex 的钩子桥接通过 `session-activity-tracker.mjs` PostToolUse 钩子记录活动。这使得可以追踪研究会话期间使用了哪些技能——与实验和知识文件使用的访问日志基础设施相同。钩子桥接和 PostToolUse 钩子系统详见 [hooks.md](./hooks.md)。
