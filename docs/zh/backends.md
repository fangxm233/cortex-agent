# 后端


后端是 Cortex 对特定编程智能体 CLI 的适配器。Cortex 不直接调用 LLM API。它将编程智能体（Claude Code、PI 或 Codex）作为子进程启动，向其发送消息，并消费标准化的事件流。每个后端实现 `agent-server/src/agent-adapter/types.ts` 中定义的 `AgentAdapter` 接口。

## 支持的后端

| 后端 | 状态 | 可执行文件 | npm 包 | 功能级别 |
|---|---|---|---|---|
| Claude Code | 已支持 | `claude` | `@anthropic-ai/claude-code` | 完整（8/8 能力） |
| PI | 已支持 | `pi` | `@mariozechner/pi-coding-agent` | 完整（8/8 能力） |
| Codex | 计划中 | `codex` | — | 部分（3/8 能力） |

## 后端如何工作

当智能体会话开始时，Cortex 解析活动配置（从 `profiles.json` 或 `--profile` 标志）以确定使用哪个后端。然后它调用 `getAdapter(backend)` 获取适配器实例，并调用 `adapter.spawn(config)` 启动会话。

`AgentSpawnConfig` 携带完整的会话上下文：系统提示、插件目录、工具允许列表、MCP 服务器配置、钩子、模型名称和后端特定的透传参数。适配器将其转换为后端原生的 CLI 参数并启动编程智能体。

从那里，Cortex 发送用户消息并接收标准化的事件流。标准化层（`agent-adapter/normalize/`）将每个后端的原生事件格式转换为公共的 `NormalizedEvent` 可区分联合类型，因此编排层永远不需要知道运行的是哪个后端。

## 功能矩阵

Cortex 定义了后端可能支持的八种能力。编排层在尝试后端特定操作之前检查这些能力。

| 能力 | Claude Code | PI | Codex | 描述 |
|---|---|---|---|---|
| `hooks` | 是 | 是 | 否 | 通过 hook-bridge 的 PreToolUse/PostToolUse/Stop 钩子 |
| `plugins` | 是 | 是 | 否 | 通过 `--skill` 或等效方式的角色限定技能插件 |
| `mcp` | 是 | 是 | 是 | MCP 工具服务器集成 |
| `plan-mode` | 是 | 是 | 否 | EnterPlanMode/ExitPlanMode 工具支持 |
| `ask-user-question` | 是 | 是 | 否 | AskUserQuestion 工具支持 |
| `system-prompt-override` | 是 | 是 | 是 | 自定义系统提示注入 |
| `session-resume` | 是 | 是 | 是 | 恢复已有会话 |
| `tool-allowlist` | 是 | 是 | 否 | 将可用工具限制为子集 |

## Claude Code

参考后端。原生支持所有八种能力。有两种适配器模式可用：

**Print 模式**（`claudeBackend: "print"`，默认）。使用 `claude -p --stream-json` 进行一次性回合。每条用户消息生成一个新的 Claude 调用。快速、无状态，是大多数使用场景的推荐模式。

**TUI 模式**（`claudeBackend: "tui"`）。在 tmux 下生成交互式 Claude 会话，并尾随会话的 JSONL 文件获取事件。支持带会话持久化的多轮对话。资源使用更重，但允许交互式工作流。

Claude Code 适配器会话池按键频道以重用会话。费用报告从 `message.usage` 令牌计数逆向推导 USD 费用，使用 Anthropic 发布的定价。

## PI

与 Claude Code 功能完全对等。PI 的适配器在 PI 原生功能集不同的地方弥补差距：

- **MCP** — 通过 `mcp-bridge.ts` 实现，这是一个将 PI 连接到 Cortex MCP 服务器的扩展。在生成时通过 `--extension` 自动注入。
- **PlanMode / AskUserQuestion** — 通过 `tool-shims.ts` 伪工具实现，将 `ask`、`exit_plan` 和 `todo` 注册为一等 PI 工具，通过 `extension_ui_response` 路由响应。
- **钩子** — 通过 `hook-bridge.ts` 实现，将 PI 工具事件转换为 Cortex 钩子脚本。
- **插件** — PI 原生的 `--skill` 标志映射到 Cortex 的插件系统。

PI 会话使用 `--session <path>` 进行恢复，使用 `--system-prompt` 覆盖系统提示。适配器处理 PI 事件流的 LF-only NDJSON 帧格式。

## Codex

Codex 目前支持三种能力：MCP、系统提示覆盖和会话恢复。适配器存在于代码库中，但此后端标记为计划中而非已支持。

## 选择后端

后端在 `$CORTEX_HOME/config/profiles.json` 中按配置选择（完整配置模式参见 [configuration.md](./configuration.md)）：

```json
{
  "defaultProfile": "plan",
  "profiles": {
    "plan": {
      "model": "claude-sonnet-4-20250514",
      "backend": "claude"
    },
    "execute": {
      "model": "claude-sonnet-4-20250514",
      "backend": "pi"
    }
  }
}
```

`backend` 字段接受 `"claude"`、`"pi"` 或 `"codex"`。如果省略，默认为 `"claude"`。

线程模板也可以为每个智能体指定配置，允许同一管道中的不同智能体使用不同的后端。模板配置参见 [threads.md](./threads.md)。

## 思考档位

可选的 `thinking` 配置字段设置后端的推理深度。每个后端以其原生标志接收：Claude Code 为 `--effort <level>`（`low`/`medium`/`high`/`xhigh`/`max`），PI 为 `--thinking <level>`（`off`/`minimal`/`low`/`medium`/`high`/`xhigh`）。Codex 没有思考档位传递，在 codex 配置上声明该字段会导致校验失败。字段缺省时不传递任何标志，后端使用自身默认值，因此现有配置行为不变。fallback 条目不继承主配置的值——每条自行声明。

## 回退行为

每个配置项可以指定一个 `fallback` 数组作为备选配置。如果主后端调用因瞬态错误失败（网络超时、速率限制、认证），Cortex 按顺序遍历回退链。每个回退项继承主配置中未指定的字段。

示例：

```json
{
  "plan": {
    "model": "claude-sonnet-4-20250514",
    "backend": "claude",
    "fallback": [
      { "model": "claude-sonnet-4-20250514", "backend": "pi" }
    ]
  }
}
```

## 用量限流与自动恢复

回退链处理的是单次调用失败。提供商在数小时滚动窗口上施加的用量限制由另一套机制处理。当某个后端报告五小时用量窗口已耗尽、且所有已配置的回退也都用尽时，Cortex 会停止向该限制发送新工作，直到窗口重置，并记录下每一项被中断的工作——直接对话和线程都包括在内。

Cortex 读取提供商报告的重置时间，并在窗口重新开放几秒后解除限流。届时它会重新打开每一项被中断的工作，并注入一条简短提示，告诉 agent 限制已解除、从中断处继续。直接对话会在其所在频道原地恢复，且保留此前的上下文；线程则从上一步继续。多项恢复之间会错开几秒，以免立即把刚重置的窗口再次耗尽。

限流状态与被中断工作的清单持久化在 `schedules.json` 中，因此窗口期间重启不会丢失任何东西：启动时 Cortex 会重新装载定时器，或在窗口已于宕机期间过去时立即恢复。已经过期的工作（记录于六小时前）、已有活跃 agent 的频道、或此后已结束的线程，会被跳过而不恢复。

自动恢复默认开启。在 `.env` 文件中设置 `CORTEX_AUTO_RESUME=0` 可改为让被中断的工作保持暂停、由人工继续。

## 费用报告

费用报告因后端而异：

- **Claude Code** — 从 `message.usage` 令牌计数（输入/输出）逆向推导 USD 费用，使用 Anthropic 发布的每模型定价。费用写入 `$CORTEX_HOME/data/costs.jsonl`。
- **PI** — 费用报告取决于 PI 编程智能体的提供商配置。适配器捕获 PI 发出的任何费用元数据。
- **Codex** — 费用报告尚未实现。

所有费用记录遵循相同的 JSONL 格式，并受 90 天滚动保留窗口的约束。通过 MCP 工具的费用查询汇总所有后端——`cost_query` 工具参见 [mcp.md](./mcp.md)。

## 添加新后端

新后端在 `agent-server/src/agent-adapter/` 下的新目录中实现 `AgentAdapter` 接口。所需接口：

1. **`adapter.ts`** — 实现 `AgentAdapter`，包括 `spawn()`、`close()`、`kill()` 和 `listSessions()`。从 `spawn()` 返回 `AgentProcess`。
2. **`AgentProcess`** — 暴露用于用户消息的 `send(message)` 和作为 `NormalizedEvent` 异步可迭代的 `events`。还必须支持 `close()` 和 `kill()`。
3. **`event-parser.ts`** — 将后端的原生事件格式转换为 `NormalizedEvent` 可区分联合成员。
4. **注册** — 将适配器添加到 `agent-adapter/index.ts` 中的 `ADAPTERS` 映射，将能力添加到 `capabilities.ts`，并将后端标签包含在 `types.ts` 的 `Backend` 类型联合中。

标准化层（`agent-adapter/normalize/`）提供所有后端使用的事件流排队、工具名称转换和钩子规范的共享工具。
