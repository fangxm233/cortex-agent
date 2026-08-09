# Cortex 技能与插件 {#cortex-skills-and-plugins}

Cortex 用技能封装可复用的智能体指令，用插件封装可安装的能力集合。插件可以只提供技能；符合 portable Agent Plugins 格式时，也可以同时提供技能与 Model Context Protocol（MCP）服务器。插件分配作用于具体 agent 或 template slot，因此每次生成的 backend 只获得所选能力面。

## 技能 {#skills}

技能是以 `SKILL.md` 为入口的目录。YAML frontmatter 描述何时适用，Markdown 正文则是在调用 `Skill` 工具时展开的指令。一个最小 portable skill 如下：

```yaml
---
name: summarize
description: Use when a long artifact needs a concise technical summary
---

# Summarize

Read the complete artifact, preserve evidence links, and report the main result.
```

目录名必须与 frontmatter 的 `name` 一致。Portable skill 名称使用小写字母、数字和单个连字符；Cortex 只发现插件 `skills/` 目录的直接子目录。脚本、参考资料等支持文件可以放在各自 skill 目录之下。

Cortex 也会扫描 `$CORTEX_HOME/.claude/skills/` 中的 standalone user skills。这些独立技能不进入插件清单，也不参与 plugin assignment。

## 支持的插件格式 {#supported-plugin-formats}

Cortex 会盘点 `$CORTEX_HOME/plugins/` 的每个直接子目录。它识别 portable Agent Plugins 1.0.0 Working Draft，也保留现有 Claude-compatible legacy layout。

| 格式 | Manifest | Skills | Cortex portable MCP |
|---|---|---|---|
| Agent Plugins 1.0 | 插件根目录的 `plugin.json` | 直接子项 `skills/<name>/SKILL.md` | 根目录 `mcp.json` |
| Legacy | `.claude-plugin/plugin.json` | 直接子项 `skills/<name>/SKILL.md` | 不进入 catalog，也不做 cross-backend mapping |

根目录 `plugin.json` 优先。如果它存在但有 fatal validation error，Cortex 会把该 portable package 报告为无效，而不会回退到 legacy manifest。Unknown top-level fields 与非 object 的 `extensions` 会被报告并忽略，属于 non-fatal exceptions。只有根目录 `plugin.json` 缺失时才考虑 legacy manifest。Portable 格式及其故障边界遵循 [Agent Plugins 1.0.0 specification](https://agent-plugins.org/specification)，同时 Cortex 继续兼容已有 legacy 安装。

Legacy directory 会原样传给 backend。因此 Claude 仍可解释 legacy package 根目录 `.mcp.json` 等 Claude-native files；这些 servers 不进入 Cortex inventory、summary 或 acknowledgment gate，也不会映射到 PI。MCP 需要在 Settings 可见并在 Claude 与 PI 保持一致时，应使用 portable root `mcp.json`。

## Portable package 布局 {#portable-package-layout}

Portable package 采用以下布局：

```text
my-plugin/
├── plugin.json
├── skills/
│   └── summarize/
│       ├── SKILL.md
│       └── references/
└── mcp.json
```

最小 manifest 选择 Cortex 支持的精确 schema：

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Summarization skills and tools"
}
```

Cortex 使用本地 vendored schema 校验 manifest，加载插件时不会联网获取 schema。Package 目录名是 Cortex 的 assignment identity，manifest name 提供 portable runtime namespace。Package 文件、manifest、skill entry point、plugin-relative command 与基于 plugin root 的工作目录在解析后都必须留在 plugin root 内；`${PLUGIN_DATA}` 工作目录则必须留在该插件的 data root 内。Symlink 等路径逃逸会在最窄的 component boundary 被拒绝。

无效 portable manifest 会使插件不可分配。无效 skill 会被跳过，其他有效 sibling skills 仍可用。顶层 `mcp.json` 错误只会禁用该插件的 MCP，不会禁用有效 skills；单个 MCP server entry 无效时只跳过该 entry。Plugins 页面会显示这些问题，而不是静默隐藏。

## Portable MCP servers {#portable-mcp-servers}

Portable `mcp.json` 可声明 stdio、Streamable HTTP 或 legacy HTTP+SSE server，其 schema version 必须与 `plugin.json` 一致。

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "local-tools": {
      "type": "stdio",
      "command": "./bin/server",
      "args": ["--data", "${PLUGIN_DATA}"],
      "env": {
        "CONFIG": "${PLUGIN_ROOT}/config.json"
      },
      "cwd": "${PLUGIN_ROOT}"
    },
    "remote-tools": {
      "type": "streamable-http",
      "url": "https://tools.example.com/mcp",
      "headers": {
        "X-Tenant": "public"
      }
    }
  }
}
```

Stdio `command` 是单个 executable token，而不是 shell command。它可以是 bare executable name，也可以是受 containment 约束的 `./` path。Cortex 只在 `args`、environment values 与 `cwd` 中展开 `${PLUGIN_ROOT}` 和 `${PLUGIN_DATA}`；这两个变量由 Cortex 自己提供，名称不可被 package 覆盖。每个插件的持久数据目录为 `$CORTEX_HOME/data/plugin-data/<plugin-id>/`，只在被选中的 stdio server materialize 时创建。

Remote server 除 loopback HTTP 外必须使用 HTTPS。包含 credentials 或 fragment 的 URL 会被拒绝，configured headers 也不是 portable secret mechanism。两个 backend 都会拒绝所有 remote MCP redirect：PI 直接使用共享的 redirect-rejecting fetch，Claude 则通过采用相同策略的本地 stdio proxy 访问每个 remote server。这样不会向 redirect target 重放 configured headers 或 request body（`agent-server/src/agent-adapter/mcp-remote-fetch.ts:20-38`；`agent-server/src/agent-adapter/claude/remote-mcp-proxy.ts:48-62`）。Settings UI 对 remote server 只显示 origin 与 header names；对 stdio 只显示 executable basename、argument count 和 environment key names。Environment 与 header values 不会返回浏览器。

详细 transport 与隔离规则来自 [Agent Plugins MCP runtime contract](https://agent-plugins.org/client-implementers/mcp-runtime)。Cortex 在 Claude 与 PI 中实现三种声明式 transport。

## 分配插件 {#assigning-plugins}

桌面与浏览器工作台通过 **Settings → Plugins** 提供 catalog。页面读取当前连接的 Cortex server，因此清单和分配属于该 server，而不是本机 desktop 安装。页面显示每个 package 的格式、manifest metadata、validation state、skills、sanitized MCP summary 与 issues。

Target selector 覆盖 agent definition、普通 template slot、shell binding 与 `__active__` slot。Agent target 保存完整 managed plugin set。普通 template slot 可以使用所引用 agent 的 defaults，也可以自定义一个完整 snapshot。Custom snapshot 不会追踪 agent 后续变化；切回 agent defaults 会删除 slot-level `pluginDirs` override。Shell binding 与 `__active__` slot 没有稳定可写的 assignment location，因此是只读的。

保存时使用 entity content hash 做 optimistic concurrency guard。如果 agent 或 template 已在磁盘上变化，Cortex 会刷新 target，而不是覆盖新内容。Managed catalog 之外的既有 plugin path 会被保留，并显示为 unmanaged。已经选中的无效 catalog entry 可以移除，但不能新分配无效 entry。

加入至少含一个有效 root `mcp.json` server 的 portable plugin 时，会弹出确认，说明本地代码执行与网络访问的信任面。该 portable MCP assignment 必须确认，但确认不是 sandbox，也不是独立 authorization boundary。Reset 会丢弃本地草稿，Save 则通过 `plugins.assign` 持久化。Plugin assignment 草稿为 dirty 时，Settings modal 会阻止切换 target 或关闭。如果后台 refetch 返回不同的 assignment hash，页面会保留用户草稿、标记 stale、禁用 Save，并要求 Reset，而不是静默替换编辑（`web/src/features/settings/plugins-panel-vm.ts:143-164,199-210`）。

Assignment 继续写入 agent 和 template JSON 的 `pluginDirs`，不引入第二套字段。Agent 可直接配置为：

```json
{
  "name": "researcher",
  "profile": "claude-sonnet",
  "pluginDirs": [
    "plugins/cortex-common",
    "plugins/my-plugin"
  ]
}
```

没有 `pluginDirs` 的 template slot 继承所引用 agent。带 `pluginDirs` 的 slot object 表示完整 custom set：

```json
{
  "name": "special-review",
  "agents": [
    {
      "ref": "researcher",
      "pluginDirs": ["plugins/my-plugin"]
    }
  ],
  "transitions": [],
  "entryAgent": "researcher",
  "maxTotalSteps": 4
}
```

相对路径基于 `$CORTEX_HOME` 解析；absolute path 继续作为 unmanaged legacy configuration 受到支持。Settings UI 会把 managed entry 规范化为 `plugins/<plugin-id>`，同时保留 unmanaged entries。

## Backend 加载 {#backend-loading}

Cortex 在 spawn 时重新读取所选 catalog。Legacy plugin directory 保留原有 backend path behavior。Portable skill support tree 会先做 containment check 与 content hash，再复制到 backend-specific private projection。Claude 通过 `--plugin-dir` 获得 compatibility projection；PI 通过重复的 `--skill` argument 只获得其 private projection 内的 skill directories。两个 backend 都不会直接获得指向 mutable installed package 的 portable skill path（`agent-server/src/domain/plugins/skill-projection.ts:23-151`；`agent-server/src/domain/plugins/runtime.ts:346-494,629-632`）。

Portable MCP declaration 经过同一个 backend-neutral normalization layer。Claude 获得 private supplemental config；其中的 remote entry 是本地 stdio proxy，remote URL 与 headers 保存在独立 private file。PI 获得由 Cortex MCP bridge 消费的 private content-addressed config。组件按声明的 dependency boundary 隔离失败：invalid 或无法 materialize 的 skill 不会移除 sibling skills 或有效 MCP；plugin-scoped `PLUGIN_DATA` 不可用时，会省略共享它的 stdio servers，但保留 remote MCP 与 skills；remote/stdio process 也与 sibling processes 和 bundled tools 独立连接（`agent-server/src/domain/plugins/runtime.ts:186-205,346-494`；`agent-server/src/agent-adapter/claude/mcp-config.ts:105-164`；`agent-server/src/agent-adapter/pi/mcp-bridge.ts:299-476`）。

Capability fingerprint 覆盖 effective plugin paths、portable skill content、projected manifest 与 normalized MCP declarations。Claude pooled session 只会复用 capability 相同的 process，因此 assignment 及这些 covered inputs 的变化会选择兼容的 process boundary。Legacy package content 与 executable bytes 等 auxiliary portable files 不做 content hash；只改变这些文件并不保证替换 process。Portable skill name、portable namespace 或 MCP runtime name 发生冲突时，该 assignment set 会 fail closed。

在显式 `none`、benchmark thread-run composition 与受限 PI `Agent` subagent surface 上，portable MCP 会被抑制。这可避免 plugin capability 进入本来就有意收窄的 execution mode。

## 信任与管理 {#trust-and-administration}

`$CORTEX_HOME/plugins/` 下的所有内容都属于 administrator-installed code。只应分配来源与内容可信的 package：stdio MCP server 可以用 backend process account 执行本地代码，remote MCP server 可以通过网络接收 tool data。Portable skills 会复制到 private snapshot，但 stdio commands、arguments、working directories 与 package data 仍是 administrator-controlled trusted runtime inputs，而不是 sandbox boundary。Manifest validation、path containment、private runtime files、redirect rejection 与 assignment confirmation 可以减少配置错误和 secret 暴露，但不会 sandbox plugin behavior。

Plugins 页面只管理 inventory 与 assignment。其 MCP inventory 与 acknowledgment 只适用于 portable root `mcp.json`；legacy Claude-native `.mcp.json` 不在该 managed view 中。安装、marketplace search、update、removal、OAuth、credential entry、per-tool permission policy 与 live MCP health check 不属于该页面。安装 package 需要通过 administrator-controlled workflow 把其目录放入 `$CORTEX_HOME/plugins/`。

## 技能发现与调用 {#skill-discovery-and-invocation}

`!skills` 命令按插件分组显示已发现技能。Plugin skill 使用 `cortex-common:synthesize` 这样的 plugin-qualified discovery identity，standalone user skill 使用 bare name。消息开头的已知 bare command 可以在调用前规范化为 slash form。

通过 `Skill` 工具调用技能时，Cortex hook bridge 会由 session activity tracker 记录活动。它复用 experiment 与 knowledge 文件的 access-tracking infrastructure；hook bridge 详见 [hooks.md](./hooks.md)。

## 实现依据 {#implementation-references}

| 行为 | 来源 |
|---|---|
| Catalog precedence、fixed locations 与窄故障隔离 | `agent-server/src/domain/plugins/catalog.ts:224-390` |
| Portable MCP validation 与 sanitized summaries | `agent-server/src/domain/plugins/mcp.ts:102-323` |
| Spawn-time projection、normalization 与 fingerprint | `agent-server/src/domain/plugins/runtime.ts:143-688` |
| Agent 与 template assignment persistence | `agent-server/src/domain/ui-service/mutate/plugins.ts:84-242` |
| Connected-server catalog 与 target inventory | `agent-server/src/domain/ui-service/query/plugins.ts:32-172` |
| Settings assignment 与 MCP acknowledgment | `web/src/features/settings/PluginsPanel.tsx:365-800` |
