# Cortex 技能与插件 {#cortex-skills-and-plugins}

Cortex 用 skill 承载可复用的智能体指令，用插件承载可安装的能力包。插件可以只提供 skill；遵循可移植的 Agent Plugins 格式时，还可以同时提供 skill 和 Model Context Protocol（MCP）server。插件分配给[执行环境](./configuration.md#execution-environments)，每个被启动的 backend 只拿到其执行环境选定的那部分能力。

## Skills {#skills}

一个 skill 就是一个以 `SKILL.md` 为入口的目录。其中的 YAML frontmatter 说明 skill 的适用场景，Markdown 正文则是 `Skill` 工具展开的指令。最小的可移植 skill 如下：

```yaml
---
name: summarize
description: Use when a long artifact needs a concise technical summary
---

# Summarize

Read the complete artifact, preserve evidence links, and report the main result.
```

frontmatter 中写了 `name` 时，它必须与目录名一致。可移植 skill 的名称只能由小写字母、数字和单个连字符组成——Settings 编辑器在新建或移动 skill 时会强制这一格式——而且 Cortex 只发现插件 `skills/` 目录的直接子目录。skill 可以在自己的目录下存放脚本、参考资料等配套文件。Cortex 只校验可移植 skill 的 frontmatter；legacy 插件包中的 skill 原样交给 backend。

加载器刻意保持宽松。只有完全无法使用的 skill 才会被丢弃：frontmatter 无法解析、`name` 与目录名矛盾，或 `description` 为空。其余情况——缺少 `name`、名称不规范、`description` 过长、可选字段格式错误、`allowed-tools` 写成 YAML 列表，或者出现规范之外的键——都会照常加载，并在插件详情页上作为提示性问题列出。因为一个多余的 frontmatter 键而丢掉一个能用的 skill，比容忍这个键更糟，也更不容易察觉。

## 支持的插件格式 {#supported-plugin-formats}

Cortex 会清点它的[内置插件](#built-in-plugins)，以及 `$CORTEX_HOME/plugins/` 下的每个直接子目录。它识别可移植的 Agent Plugins 1.0.0 Working Draft，以及现有的 Claude 兼容 legacy 布局。

| 格式 | Manifest | Skills | Cortex 可移植 MCP |
|---|---|---|---|
| Agent Plugins 1.0 | 插件根目录下的 `plugin.json` | 直接子目录 `skills/<name>/SKILL.md` | 根目录 `mcp.json` |
| Legacy | `.claude-plugin/plugin.json` | 直接子目录 `skills/<name>/SKILL.md` | 不纳入目录，也不跨 backend 映射 |

根目录的 `plugin.json` 优先。如果它存在但有致命的校验错误，Cortex 会把这个可移植插件包报告为无效，而不会退回到 legacy manifest。未知的顶层字段和非对象类型的 `extensions` 值会被报告并忽略，作为非致命异常处理。只有根目录没有 `plugin.json` 时，才会考虑 legacy manifest。可移植格式及其失败边界遵循 [Agent Plugins 1.0.0 规范](https://agent-plugins.org/specification)，Cortex 则为已有安装保留 legacy 布局。

Legacy 目录原样传给 backend。因此 Claude 可以解析 Claude 原生的文件，例如 legacy 插件包根目录下的 `.mcp.json`；这些 server 不会被 Cortex 清点、汇总或要求确认，也不会映射到 PI。如果 MCP 需要在 Settings 中可见，并在 Claude 与 PI 之间保持一致，请使用可移植的根目录 `mcp.json`。

## 内置插件 {#built-in-plugins}

Cortex 在安装目录的 `agent-server/defaults/plugins/` 下自带三个可移植插件：`cortex-system`（审批、定时任务、项目初始化、客户端管理、学习用户偏好）、`cortex-board`（看板）和 `cortex-feishu`（飞书文档，在飞书会话中加载；开启 `settings.feishuSkillsInWeb` 后也在 web 会话中加载）。Cortex 直接从安装目录读取它们，从不复制到 `$CORTEX_HOME`，因此它们始终与正在运行的版本一致。

如果 `$CORTEX_HOME/plugins/<id>/` 的目录名恰好是某个内置插件的 id，它就是该插件的用户层，而不是一个独立的插件。内置 manifest 依然生效，用户层逐项修改插件：

- 带 `SKILL.md` 的 `skills/<name>/`，如果内置插件有同名 skill，则整体替换该 skill，连同配套文件；
- 其他名称的 `skills/<name>/` 为插件新增一个 skill；
- `mcp.json` 整体替换插件的 MCP 声明。

从用户层删掉某个 skill 目录或 `mcp.json`，内置版本就会恢复。目录会标明每个 skill 的来源：内置、已修改（用用户的版本代替内置版本）或本地（用户自己的）。

内置插件在每个加载 skill 的执行环境中都会加载。执行环境要关闭某个内置插件，只需在 `disabledPlugins` 中写上它的名字（见[分配插件](#assigning-plugins)）。设置了 `"skills": false` 的执行环境只加载 `pluginDirs` 列出的插件；sealed home（`CORTEX_CONFIG_IMMUTABLE=1`，例如 benchmark 试验中）没有内置插件。

## 可移植插件包布局 {#portable-package-layout}

可移植插件包的结构如下：

```text
my-plugin/
├── plugin.json
├── skills/
│   └── summarize/
│       ├── SKILL.md
│       └── references/
└── mcp.json
```

最小的 manifest 会指定所支持的确切 schema：

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Summarization skills and tools"
}
```

Cortex 用随代码一起分发的本地 schema 校验 manifest，加载插件时不会去网上获取 schema。插件包的目录名是它在 Cortex 中用于分配的标识；manifest 中的 name 则提供可移植运行时的命名空间。插件包里的文件、manifest、skill 入口、相对插件路径的命令，以及基于插件根目录的工作目录，都必须位于解析后的插件根目录之内。`${PLUGIN_DATA}` 形式的工作目录则必须位于该插件的数据根目录之内。符号链接或其他等效的路径逃逸会在最窄的路径分量边界上被拒绝。

可移植 manifest 无效时，插件无法被分配。无效的 skill 会被跳过，同一插件中其他有效的 skill 仍然可用。顶层 `mcp.json` 出错会禁用该插件的 MCP，但不影响有效的 skill；某个 MCP server 条目无效时只跳过这一条，其他有效的 server 保留。Plugins 页面会把这些问题展示出来，而不是悄悄隐藏。

## Portable MCP servers {#portable-mcp-servers}

可移植的 `mcp.json` 可以声明 stdio、Streamable HTTP 或 legacy HTTP+SSE 三种 server。其 schema 版本必须与 `plugin.json` 一致。

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

stdio 的 `command` 是单个可执行文件，而不是一条 shell 命令。它可以是不带路径的可执行文件名，也可以是位于插件目录内的 `./` 路径。Cortex 只在 `args`、环境变量值和 `cwd` 中展开 `${PLUGIN_ROOT}` 和 `${PLUGIN_DATA}`；这两个变量由 Cortex 自己提供，变量名也被保留。插件专属的持久数据目录是 `$CORTEX_HOME/data/plugin-data/<plugin-id>/`，只在某个被选中的 stdio server 实际落地时才创建。

远程 server 必须使用 HTTPS，回环地址上的 HTTP 除外。包含凭据或 fragment 的 URL 会被拒绝，配置的 header 也绝不会被当作可移植的密钥机制。两个 backend 都会拒绝所有远程 MCP 重定向：PI 直接使用共享的、拒绝重定向的 fetch，Claude 则经由一个执行相同策略的本地 stdio 代理访问每个远程 server。这样可以防止配置的 header 和请求体被重放到重定向目标（`agent-server/src/agent-adapter/mcp-remote-fetch.ts`；`agent-server/src/agent-adapter/claude/remote-mcp-proxy.ts`）。Settings 界面对远程 server 只显示 origin 和 header 名称；对 stdio server 只显示可执行文件的 basename、参数个数和环境变量的键名。环境变量值和 header 值不会返回给浏览器。

详细的传输与隔离规则来自 [Agent Plugins MCP 运行时约定](https://agent-plugins.org/client-implementers/mcp-runtime)。Cortex 在 Claude 和 PI 上实现了全部三种声明的传输方式。

## 查看插件 {#inspecting-a-plugin}

桌面端和浏览器工作台在 **Settings → Plugins** 提供插件目录。该页面读取的是当前连接的 Cortex server，因此其中的条目属于这台 server，而不是本地的桌面端安装。页面列出所有已安装的插件包，每个插件包打开后有三个标签页：Overview、Skills 和 MCP。**New plugin** 会创建一个本地可移植插件包——一个版本为 0.1.0 的 `plugin.json` 和一个空的 `skills/` 目录——名称不能与内置插件的 id 相同。

Overview 展示插件包的身份与健康状况：格式、manifest 来源与元数据、磁盘位置、校验问题，以及启动时的作用域限制。它还列出当前引用该插件的执行环境，让这层关系从插件包一侧也能查到，但不由这个页面负责维护。

## 管理插件内容 {#managing-a-plugins-contents}

Skills 标签页列出插件包自带的 skill 及各自的描述和路径，并可以编辑。打开一个 skill 即进入它的 `SKILL.md`；保存时以打开时的 hash 为准，所以如果文件在编辑期间被别处改动，会产生冲突，而不是被悄悄覆盖。新 skill 从模板创建，需要填写名称和必填的描述；已有 skill 可以重命名或移动到另一个插件，移动时会改写 frontmatter 中的 `name`（只改 frontmatter），使其继续与目录一致。新建或移动的 skill 不能使用内置 skill 的名称。删除会移除 skill 目录及其下的全部内容。

MCP 标签页以表单形式编辑 `mcp.json`。命令、参数、工作目录和 URL 可以正常读取和写回，但环境变量值和 header 不行：这个页面从来拿不到它们。每个已存储的键都显示为保持不变，替换某个键需要显式操作；你没有动过的键由服务端从磁盘上已有的内容合并回去，而你从表单中删掉的键也会从文件中删除。与 skill 编辑器不同，MCP 表单保存时不做冲突检查，以最后一次保存为准。Legacy 插件包根本不能声明 MCP server，因此它的 MCP 标签页提供的是格式转换——写入根目录的 `plugin.json`，同时保留 `.claude-plugin/plugin.json` 不动。保存内置插件的 MCP 表单时，`mcp.json` 会写入它的用户层。

列表中会标出内置插件，每个 skill 也会显示它是内置、已修改还是本地。内置 skill 和其他 skill 一样可以打开和保存：保存时，带着你的修改把 skill 目录复制到 `$CORTEX_HOME/plugins/<id>/skills/<name>/`，由它替换内置 skill；之后该 skill 显示为已修改，并提供 **Revert to built-in** 操作，确认后删除你的版本。内置 skill 和已修改的 skill 不能移动、重命名或删除；对应按钮处于禁用状态并说明原因。内置插件同样不能删除：它的删除对话框会说明这一点，确认按钮始终禁用。你在内置插件中新增的 skill 属于你自己，可以移动和删除。本地插件包在没有任何执行环境引用它之后即可删除。

## 分配插件 {#assigning-plugins}

分配是执行环境的一个字段，而不是插件的属性，所以要在执行环境上编辑：打开 **Settings → Environments**，选中一个执行环境，再进入 Plugins 标签页（新建的执行环境保存之后才会出现该标签页）。每个执行环境只有一套插件集合，目录中的每个插件对应一个开关。内置插件带有标记且默认开启；关闭某个内置插件会把它记入该执行环境的 `disabledPlugins`，而开启的本地插件则列在 `pluginDirs` 中。

保存时以执行环境文件的内容 hash 作为乐观并发控制的依据。如果该执行环境在磁盘上已被修改，Cortex 会刷新目标，而不是覆盖更新的文件。托管目录之外已有的插件路径会原样保留，并标为非托管。已经选中的无效目录条目可以移除，但不能新分配无效条目。

添加一个至少含有一个有效根目录 `mcp.json` server 的可移植插件时，会弹出确认框，说明这会引入本地代码执行与网络访问方面的信任风险。添加这类可移植 MCP 必须经过确认，但确认既不是沙箱，也不是独立的授权边界。Reset 丢弃本地草稿，Save 则通过 `plugins.assign` 将其持久化。分配草稿有未保存修改时，Settings 弹窗会阻止切换分区和关闭。如果后台重新拉取得到的分配 hash 与当前不同，页面会保留用户的草稿、将其标为过期、禁用 Save，并要求先 Reset，而不是悄悄替换用户的修改（`web/src/features/settings/vm/plugin-assign-vm.ts`）。

分配标签页和 JSON 正文编辑器写的是同一个文件，因此同一时刻只能有一方持有草稿：正文有未保存修改时，该标签页处于冻结状态。此外，分配也不是插件是否加载的最终决定。带作用域的插件在启动时还会再过滤一次，所以限定频道作用域的插件包会显示一条内联提示：无论怎么分配，超出该作用域都不会加载。

分配结果保存在 `$CORTEX_HOME/config/environments/` 下该执行环境的 JSON 文件中，也可以直接写在文件里：

```json
{
  "name": "researcher",
  "pluginDirs": [
    "plugins/my-plugin"
  ],
  "disabledPlugins": [
    "cortex-feishu"
  ]
}
```

该执行环境的会话先按顺序加载 `pluginDirs` 列出的插件，再加载 `disabledPlugins` 中未列出的所有内置插件。手动写进 `pluginDirs` 的内置插件会排在更靠前的位置；在 Plugins 标签页中保存时，文件会被重写，内置插件不写入 `pluginDirs`。设置了 `"skills": false` 时只看 `pluginDirs`。执行环境之间没有继承关系。

相对路径基于 `$CORTEX_HOME` 解析；绝对路径作为非托管的 legacy 配置继续受支持。Settings 界面会把托管条目规范化为 `plugins/<plugin-id>`，非托管条目则原样保留。

## Backend 加载 {#backend-loading}

Cortex 在启动 backend 时重新加载所选目录。Legacy 插件目录按其原路径交给 backend。可移植 skill 的配套文件树会经过路径包含校验、计算内容 hash，再复制到私有 snapshot 中。Claude 通过 `--plugin-dir` 获得每个可移植插件的兼容 projection；PI 则为每个 skill 获得一个 snapshot 目录，作为其进程内会话的附加 skill 路径，之后才是各个 legacy 目录。两个 backend 拿到的可移植 skill 路径都不会直接指向可变的已安装插件包（`agent-server/src/domain/plugins/skill-projection.ts`；`agent-server/src/domain/plugins/runtime.ts`）。每个 skill 都从其所属的层生成 projection：内置 skill 来自安装目录，已修改或本地的 skill 来自 `$CORTEX_HOME/plugins/<id>/`。

可移植 MCP 声明统一经过一个与 backend 无关的规范化层。Claude 获得一份私有的补充配置，其中的远程条目是本地 stdio 代理，远程 URL 和 header 保存在另外的私有文件中。PI 的 MCP bridge 从会话请求中拿到规范化后的 server 条目，并自行建立每个连接（stdio、Streamable HTTP 或 SSE）。各组件在其声明的依赖边界上独立失败：无效或无法落地的 skill 会被略去，但不影响同一插件中的其他 skill 或有效的 MCP；插件级 `PLUGIN_DATA` 不可用时，略去共用它的 stdio server，同时保留远程 MCP 和 skill；远程和 stdio 进程的连接也与其他进程及内置工具相互独立（`agent-server/src/domain/plugins/runtime.ts`；`agent-server/src/agent-adapter/claude/mcp-config.ts`；`agent-server/src/agent-adapter/pi/mcp-bridge.ts`）。当选中的 skill 或 MCP server 无法落地时，web 会话会在这一轮显示一条警告，指出缺了什么以及原因。

projection、snapshot 和私有 MCP 文件都位于 `$CORTEX_HOME/data/plugin-runtime/` 下。`$CORTEX_HOME` 本身可以经由符号链接到达（例如 home 被迁移到另一块磁盘）；但其下任何位置的符号链接都会被拒绝。每个 projection 和 snapshot 都按内容寻址：被某次启动复用的会被标记为在用，一周内没有任何启动用过的会被删除，下次需要时在同一路径重建。清理在选中了插件的启动过程中进行，每个 backend 每小时最多一次。

能力指纹涵盖实际生效的插件路径、可移植 skill 内容、生成的 projection manifest，以及规范化后的 MCP 声明。Claude 池化会话只在能力指纹一致时才复用进程，因此分配变化以及上述输入的变化都会落到一个兼容的进程边界上。Legacy 插件包内容以及可执行文件字节等可移植包的辅助文件不计算内容 hash；只改动这些文件时，不保证会替换进程。选中的可移植插件如果 `plugin.json` 无效，就不会参与这次启动，本轮的提示会写出它的名字；具体问题列在 Plugins 页面上。两个选中的可移植插件提供同名 skill 时，在执行环境插件顺序中靠前的那个保留该 skill，另一个插件加载时不带这个 skill。两个选中的可移植插件的 manifest `name`（即命名空间）相同时，靠前的保留，后面的整个跳过；Plugins 页面会在每个使用该名称的插件包上标出冲突。这两种冲突记录在 daemon 日志中，而不是本轮的提示里。可移植插件与 legacy 插件提供同名 skill 时，两者都会传给 Claude，而 PI 只保留可移植插件中的那个。

在显式的 `none` 组合下不加载可移植 MCP，subagent 则完全不加载插件——既没有 skill，也没有 MCP。这样可以把插件能力挡在那些有意只开放较窄工具集的执行模式之外。

## 信任与管理 {#trust-and-administration}

`$CORTEX_HOME/plugins/` 下的一切都是管理员安装的代码。只分配来源和内容都可信的插件包：stdio MCP server 能以 backend 进程的账户执行本地代码，远程 MCP server 能通过网络接收工具数据。可移植 skill 会被复制到私有 snapshot，但 stdio 的命令、参数、工作目录和插件包数据仍然是由管理员控制、被信任的运行时输入，而不是沙箱边界。manifest 校验、路径包含检查、私有运行时文件、拒绝重定向和分配确认可以减少配置错误和密钥泄露，但并不会把插件行为放进沙箱。

Plugins 页面管理插件清单和插件包内容，执行环境的 Plugins 标签页管理分配。其 MCP 清单和确认机制只适用于可移植的根目录 `mcp.json`；Claude 原生的 legacy `.mcp.json` 不在这套托管视图之内。安装、插件市场搜索、更新、OAuth、凭据录入、按工具的权限策略以及 MCP 实时健康检查都不在这部分功能的范围内。安装插件包的方式，是通过管理员控制的流程把它的目录放到 `$CORTEX_HOME/plugins/` 下。

## Skill 的发现与调用 {#skill-discovery-and-invocation}

`!skills` 命令按插件分组，列出当前对话会加载的 skill，即其执行环境经作用域过滤后的插件。可移植插件显示目录接受的 skill；原样交给 backend 的目录（legacy 插件包，或 `$CORTEX_HOME/plugins/` 之外的路径）显示其中的 `skills/<name>/SKILL.md` 条目，如果它不是目录中的插件，则以配置的路径作为标签。Skills 视图以同样的方式列出所有目录插件的 skill。

当 skill 的描述与任务相符时，智能体会自行通过 `Skill` 工具调用它。你也可以显式调用。在 Web UI 和桌面端中，在输入框键入 `/` 会弹出一个面板，列出 Cortex 的命令和当前对话加载的 skill；选中一个 skill 会按 backend 的格式插入调用——Claude 上是 `/<namespace>:<skill>`，其中命名空间是插件 manifest 中的 name，PI 上是 `/skill:<skill>`——消息按输入原样发给智能体。PI 只按名称本身解析 skill，因此两个插件提供同名 skill 时，在 PI 上只能用到第一个。

每次成功的 `Skill` 调用都会由内置的 `session-activity-tracker` hook 记录为一条 `skill_use` 事件，写入 `$CORTEX_HOME/logs/session-activity/<session_id>.jsonl`（见 [hooks.md](./hooks.md#hook-scripts)）。

## 实现参考 {#implementation-references}

| 行为 | 源码 |
|---|---|
| 目录优先级、内置层与用户层，以及窄范围校验 | `agent-server/src/domain/plugins/catalog.ts` |
| 内置插件集合，以及执行环境加载哪些插件 | `agent-server/src/domain/plugins/builtin.ts` |
| 可移植 MCP 校验与脱敏摘要 | `agent-server/src/domain/plugins/mcp.ts` |
| 启动时的 projection、规范化与指纹计算 | `agent-server/src/domain/plugins/runtime.ts` |
| 可移植 skill 的 frontmatter 校验 | `agent-server/src/domain/plugins/skill.ts` |
| 运行时 snapshot 清理 | `agent-server/src/domain/plugins/runtime-gc.ts` |
| 对话加载的 skill（`!skills`、斜杠命令面板） | `agent-server/src/domain/plugins/conversation-skills.ts` |
| 执行环境插件分配的持久化 | `agent-server/src/domain/ui-service/mutate/plugins.ts` |
| 已连接 server 的插件目录与执行环境清单 | `agent-server/src/domain/ui-service/query/plugins.ts` |
| Settings 中的插件包管理器 | `web/src/features/settings/panels/PluginsPanel.tsx` |
| 带路径包含校验的 skill 与插件用户层写入 | `agent-server/src/domain/plugins/authoring.ts` |
| 编辑操作与 MCP 密钥合并 | `agent-server/src/domain/ui-service/mutate/plugin-packages.ts` |
| Settings 中的 skill 与 MCP 编辑器 | `web/src/features/settings/panels/PluginSkillsTab.tsx`, `web/src/features/settings/panels/PluginMcpTab.tsx` |
| Settings 中的分配与 MCP 确认 | `web/src/features/settings/panels/PluginAssignPanel.tsx` |
