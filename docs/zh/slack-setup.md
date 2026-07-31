# Slack 设置 {#slack-setup}


`cortex init` 会交互式地引导你完成整个 Slack 端的设置——它打印应用清单、复制到剪贴板、给你一个 6 步的 Slack 端清单，然后收集三个令牌并进行验证。本文档是同一流程的独立参考，适用于以下情况：

- 你想在开始 `cortex init` 之前阅读步骤，
- 机器人是由团队成员创建的，你只需要知道它需要什么权限/事件，或者
- 你需要轮换令牌或将机器人迁移到新的工作区。

如果你还没有运行 `cortex init`，并且没有特别的理由提前阅读，你可以停止阅读，直接运行 `cortex init`——向导包含了以下所有内容。

## 为什么使用 Socket Mode {#why-socket-mode}

Cortex 使用 Slack 的 Socket Mode。机器人打开一个到 Slack 的出站 WebSocket 并通过它接收事件。**不需要公网入口、不需要 ngrok、不需要反向代理**——Cortex 可以在公司防火墙后面、笔记本电脑上或没有入站规则的私有 VPC 中工作。

Cortex 附带的应用清单设置了 `socket_mode_enabled: true` 和 `interactivity.is_enabled: false`。你不需要配置 Request URL。

## 创建 Slack 应用（5 分钟） {#create-the-slack-app-5-minutes}

1. 打开 [https://api.slack.com/apps](https://api.slack.com/apps)。
2. 点击 **Create New App → From a manifest**。
3. 选择你的工作区。
4. 粘贴清单（完整内容如下——`cortex init` 也会打印它并提供一个按键复制到剪贴板）。点击 **Next** 然后 **Create**。
5. Slack 会将你带到应用的基本信息页面。复制"App Credentials"下的 **Signing Secret**——这是你的 `SLACK_SIGNING_SECRET`。
6. 向下滚动到"App-Level Tokens"→ **Generate Token and Scopes**。命名为 `cortex-socket`，添加 `connections:write` 作用域，点击 **Generate**，复制令牌（以 `xapp-` 开头）——这是你的 `SLACK_APP_TOKEN`。
7. 在左侧边栏中转到 **OAuth & Permissions** → **Install to Workspace** → **Allow**。安装后你会在页面顶部看到 **Bot User OAuth Token**（以 `xoxb-` 开头）——这是你的 `SLACK_BOT_TOKEN`。
8. 在左侧边栏中转到 **App Home** → 滚动到"Show Tabs"→ 启用 **Messages Tab** 并勾选 **"Allow users to send messages from the messages tab"**。如果不勾选此项，你可以在频道中 `@cortex` 机器人但无法给它发私信。

现在你拥有了全部三个密钥。在 `cortex init` 询问时输入它们。如果 init 已经完成而你需要更新某个令牌，直接编辑 `$CORTEX_HOME/config/.env`。

## Cortex 使用的应用清单 {#the-app-manifest-cortex-uses}

这是 `cortex init` 将粘贴到你剪贴板的内容。你也可以在 <https://api.slack.com/apps> → Create New App → From a manifest 中手动导入它。

```json
{
  "display_information": {
    "name": "Cortex",
    "description": "Autonomous research agent",
    "background_color": "#2c2d30"
  },
  "features": {
    "bot_user": {
      "display_name": "Cortex",
      "always_online": true
    }
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "chat:write",
        "im:history",
        "im:write",
        "reactions:read",
        "reactions:write",
        "users:read",
        "commands",
        "app_mentions:read",
        "channels:history",
        "channels:read",
        "groups:history",
        "files:read",
        "files:write",
        "emoji:read",
        "pins:read",
        "pins:write"
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "bot_events": [
        "message.im",
        "message.channels",
        "message.groups",
        "app_mention"
      ]
    },
    "interactivity": {
      "is_enabled": false
    },
    "org_deploy_enabled": false,
    "socket_mode_enabled": true,
    "token_rotation_enabled": false
  }
}
```

### 每个作用域的用途 {#what-each-scope-is-for}

| 作用域                  | Cortex 为什么需要它                                                                  |
|------------------------|--------------------------------------------------------------------------------------|
| `chat:write`           | 在频道和私信中回复                                                                    |
| `im:history`           | 读取你发给机器人的私信                                                                |
| `im:write`             | 打开私信（例如发送启动通知）                                                          |
| `app_mentions:read`    | 接收频道中的 `@cortex` 提及                                                           |
| `channels:history`     | 读取机器人所在公共频道的消息                                                          |
| `channels:read`        | 列出机器人可以发消息的频道                                                            |
| `groups:history`       | 读取机器人所在私有频道的消息                                                          |
| `reactions:read/write` | 对命令结果和审批决策显示 ✅/❌                                                        |
| `users:read`           | 在记录中将用户 ID 映射为姓名                                                          |
| `files:read/write`     | 接收上传的文件并发布生成的产物（图表、PDF、日志）                                      |
| `emoji:read`           | 自定义表情状态指示器                                                                  |
| `pins:read/write`      | 置顶/取消置顶关键线程产物                                                             |
| `commands`             | 为未来的斜杠命令预留                                                                  |

### 每个事件的用途 {#what-each-event-is-for}

| 事件              | 触发条件                                                  |
|--------------------|-----------------------------------------------------------|
| `message.im`       | 发给机器人的私信（主要聊天界面）                           |
| `message.channels` | 机器人被邀请加入的公共频道中的消息                          |
| `message.groups`   | 机器人被邀请加入的私有频道中的消息                          |
| `app_mention`      | 机器人在频道中被 `@cortex` 提及时                          |

## 三个令牌，各自的来源 {#three-tokens-where-each-one-comes-from}

| 令牌                       | 格式              | Slack 中的位置                                                              | 对应的环境变量          |
|-----------------------------|-------------------|-----------------------------------------------------------------------------|---------------------------|
| Signing Secret              | 32 字符十六进制    | Basic Information → App Credentials                                         | `SLACK_SIGNING_SECRET`    |
| App-Level Token             | `xapp-…`          | Basic Information → App-Level Tokens → Generate Token（作用域：`connections:write`） | `SLACK_APP_TOKEN`         |
| Bot User OAuth Token        | `xoxb-…`          | OAuth & Permissions（仅在"Install to Workspace"后出现）             | `SLACK_BOT_TOKEN`         |

`cortex init` 在写入 `.env` 之前会验证 App-Level Token 是否以 `xapp-` 开头，Bot Token 是否以 `xoxb-` 开头。

## 管理频道：自动检测，无需设置 {#admin-channel-auto-detected-no-setup-needed}

设置项 `adminChannel` 是 Cortex 发送启动通知、审批请求和其他运维消息的频道。`cortex init` 不会询问它。第一次给机器人发私信时，Slack 适配器会记录频道 ID 并持久化。自动检测路径见 `src/platform/adapters/slack.ts`。

如果你想显式指定（例如你想让管理消息发送到与私信不同的频道），从 Slack 获取频道 ID（频道名称 → View channel details → 页面底部），然后在 `$CORTEX_HOME/config/settings.json` 中设置 `adminChannel`（见 [configuration.md](./configuration.md#configsettingsjson)）：

```json
{
  "adminChannel": "C0123456789"
}
```

这里的改动无需重启守护进程即可推送给正在运行的 Slack 适配器。`.env` 中的旧变量 `SLACK_ADMIN_CHANNEL` 与 `CORTEX_ADMIN_CHANNEL` 仍作为已弃用的回退被读取。

## 机器人加入工作区之后 {#after-the-bot-is-in-your-workspace}

邀请机器人到你希望它监听的任何频道：

```
/invite @Cortex
```

只要启用了 Messages Tab，私信无需邀请即可工作。

要端到端验证安装，给机器人发一条私信。如果十秒钟内没有回复，检查 `$CORTEX_HOME/logs/` 中的连接错误——最常见的是无效的 `xapp-` 令牌（Socket Mode 连接失败）或 Messages Tab 仍然被禁用（私信被静默忽略）。

## 轮换或替换令牌 {#rotating-or-replacing-a-token}

令牌存放在 `$CORTEX_HOME/config/.env` 中（完整配置参考见 [configuration.md](./configuration.md)）。直接编辑文件，然后通知守护进程重启：

```bash
cortex restart        # 触碰 $STORE_DIR/.restart
```

或者，如果你是在前台运行 `cortex start`，按 Ctrl-C 后重新启动。

管理频道的自动检测和私信信任模型有安全影响——参见 [safety-and-approvals.md](./safety-and-approvals.md)。

## 服务器自动更新（Slack 通知） {#server-auto-update-on-slack}

当 Cortex 以发布模式运行（未设置 `CORTEX_REPO` 环境变量）时，
它会定期检查 npm 上是否有更新的 `@cortex-agent/server` 版本。
首次检查在启动后 60 秒进行，之后每 24 小时检查一次。

自动更新默认开启。如需禁用，在 `$CORTEX_HOME/config/settings.json` 中设置
`"serverUpdateDisable": true`（见 [configuration.md](./configuration.md#configsettingsjson)）；
`.env` 中的旧变量 `CORTEX_SERVER_UPDATE_DISABLE=1` 仍作为已弃用的回退被读取。

当发现新版本时，Cortex 会向管理员私信发送一条带三个按钮的交互消息：

| 按钮 | 行为 |
|------|------|
| **Update** | 以分离进程方式执行 `npm install -g @cortex-agent/server@latest`。守护进程的 post-install 钩子会触碰 `.restart`，从而在大约 30 秒内重启 `app.js`。 |
| **Skip this version** | 关闭提示并将版本号记录到 `update-state.json` 中。同一版本不会再次提示；下一个新版本会触发新提示。 |
| **Cancel** | 关闭提示。下一次 24 小时检查会重新提示。 |

如果 24 小时内未按下任何按钮，提示将超时，视作 Cancel 处理。

在开发模式（`CORTEX_REPO` 指向一个存在的目录）下，检查会被完全跳过，
因为开发者直接管理安装。
