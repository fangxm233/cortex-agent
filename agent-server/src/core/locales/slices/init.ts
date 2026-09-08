// input:  nothing (leaf data slice)
// output: initEn / initZh — `cortex init` wizard + `cortex config` message slice
// pos:    one locale slice; aggregated by core/locales/en.ts & zh.ts barrels
// >>> Keep en and zh keys in lockstep (zh typed against keyof typeof initEn) <<<

export const initEn = {
  // ── Clipboard / manifest copy prompt ──
  'init.clipboard.prompt': '\nPress "c" to copy manifest to clipboard (any other key to skip)...',
  'init.clipboard.copied': 'Manifest copied to clipboard!',
  'init.clipboard.failed': 'Could not copy. If running in a terminal, ensure OSC 52 is enabled.',
  'init.clipboard.manual': 'The manifest text is shown above — please copy it manually.',

  // ── Backend install ──
  'init.backend.alreadyInstalled': '${label} is already installed.',
  'init.backend.bundled': '${label} ships with Cortex and runs in-process — nothing to install.',
  'init.backend.installing': 'Installing ${label}...',
  'init.backend.installed': '${label} installed successfully.',
  'init.backend.installFailed': 'Failed to install ${label}.',
  'init.backend.installFailedHint': 'Installation failed. Install manually: ${command}',
  'init.backend.loginHint.claude': 'Run `claude login` to authenticate.',
  'init.backend.loginHint.pi': 'Log a PI provider in from the Cortex web UI (Settings > Accounts) or with `!login pi` in chat; verify with `cortex auth status`.',
  'init.backend.label.claude': 'Claude Code',
  'init.backend.label.pi': 'PI',

  // ── Service registration ──
  'init.service.launchdWritten': 'launchd plist written to ${path}',
  'init.service.launchdStartHint': 'To start now: launchctl load ${path}',
  'init.service.systemdUserWritten': 'systemd unit written to ${path}',
  'init.service.systemdUserEnableHint': 'To enable: systemctl --user enable --now cortex (and `loginctl enable-linger` to keep it running after logout)',
  'init.service.systemdInstalled': 'systemd unit installed to ${path}',
  'init.service.systemdEnableHint': 'To enable: sudo systemctl enable --now cortex',
  'init.service.systemInstallFailed': 'Failed to install system service: ${message}',
  'init.service.noSudo': 'No sudo access. Service file saved locally.',
  'init.service.manualInstallHint': 'To install manually:\n  sudo cp ${localPath} ${systemPath}\n  sudo systemctl daemon-reload\n  sudo systemctl enable --now cortex',
  'init.service.unsupported': 'Service registration is not supported on ${platform}. Start Cortex manually with `cortex daemon`.',

  // ── Cancel ──
  'init.cancel': 'Init cancelled.',

  // ── Slack setup ──
  'init.slack.manifestTitle': 'Slack App Manifest — copy and paste when creating the app',
  'init.slack.guide': [
    'To set up Slack, you need a Slack App:',
    '',
    '1. Go to https://api.slack.com/apps',
    '2. Click "Create New App" → "From a manifest"',
    '3. Select your workspace, then paste the manifest (shown above)',
    '4. Go to "Basic Information" → copy the Signing Secret',
    '5. Under Basic Information, generate an App-Level Token',
    '   (scope: connections:write, name it "cortex-socket")',
    '6. Go to "OAuth & Permissions" → Install to Workspace',
    '   Copy the *Bot User OAuth Token* after installing',
    '7. Go to "App Home" → Show Tabs → enable *Messages Tab*',
    '   and check "Allow users to send messages from the messages tab"',
    '   (required for DM support)',
    '',
    'The manifest includes socket_mode_enabled, so Socket Mode',
    'is automatically enabled when you import it.',
    '',
    'Required Bot Token Scopes (included in manifest):',
    '  chat:write, im:history, im:write, reactions:read, reactions:write,',
    '  users:read, commands, app_mentions:read,',
    '  channels:history, channels:read, groups:history,',
    '  files:read, files:write, emoji:read, pins:read, pins:write',
  ].join('\n'),
  'init.slack.guideTitle': 'Slack App Setup Guide',
  'init.slack.prefillFound': 'Found existing Slack configuration. Press Enter to skip, or type anything to re-enter.',
  'init.slack.skipPrompt': 'Skip Slack configuration? (Enter = skip, any key + Enter = re-enter)',
  'init.slack.skipPlaceholder': 'Press Enter to skip',
  'init.slack.signingSecretPrompt': 'Step 1/3: SLACK_SIGNING_SECRET (from Basic Information):',
  'init.slack.signingSecretRequired': 'Signing secret is required.',
  'init.slack.appTokenPrompt': 'Step 2/3: SLACK_APP_TOKEN (App-Level Token, starts with xapp-):',
  'init.slack.appTokenRequired': 'App token is required.',
  'init.slack.appTokenPrefix': 'Token should start with xapp-',
  'init.slack.botTokenPrompt': 'Step 3/3: SLACK_BOT_TOKEN (Bot User OAuth Token, starts with xoxb-):',
  'init.slack.botTokenRequired': 'Bot token is required.',
  'init.slack.botTokenPrefix': 'Token should start with xoxb-',

  // ── Feishu setup ──
  'init.feishu.guide': [
    'To set up Feishu (飞书), create a Feishu app:',
    '',
    '1. Go to https://open.feishu.cn/app',
    '2. Click "Create Agentic App" (创建agentic应用)',
    '3. Enter agent name (e.g. CortexAgent), select an avatar, and click Create',
    '4. After creation, the page will display App ID and App Secret — copy them directly',
    '5. Enable bot events and subscribe to: im.message.receive_v1',
    '',
    'Identity for MCP document operations (docx/wiki/bitable/sheets/drive):',
    '  - bot:  documents are created/owned by the app (default)',
    '  - user: documents are created/owned by YOUR Feishu account (Recommended)',
  ].join('\n'),
  'init.feishu.guideTitle': 'Feishu App Setup Guide',
  'init.feishu.appIdPrompt': 'FEISHU_APP_ID:',
  'init.feishu.appIdRequired': 'App ID is required.',
  'init.feishu.appSecretPrompt': 'FEISHU_APP_SECRET:',
  'init.feishu.appSecretRequired': 'App secret is required.',
  'init.feishu.domainPrompt': 'FEISHU_DOMAIN (optional, "feishu" or "lark"):',
  'init.feishu.domainPlaceholder': 'feishu (leave blank to use default)',
  'init.feishu.authModePrompt': 'Identity for MCP document operations:',
  'init.feishu.authModeBotLabel': 'bot',
  'init.feishu.authModeBotHint': 'documents owned by the app',
  'init.feishu.authModeUserLabel': 'user (Recommended)',
  'init.feishu.authModeUserHint': 'documents owned by your Feishu account',
  'init.feishu.loginStarting': 'Starting Feishu user login (OAuth device flow)...',
  'init.feishu.loginComplete': 'Feishu user login complete.',
  'init.feishu.loginIncomplete': 'Feishu user login did not complete. Retry later with `cortex feishu login`.',

  // ── Intro / backend selection ──
  'init.intro': 'Cortex Setup',
  'init.backend.noteBody': 'Both Claude Code and PI support API key access to any model.',
  'init.backend.noteTitle': 'Backend info',
  'init.backend.prompt': 'Which backends would you like to use?',
  'init.backend.claudeLabel': 'Claude Code',
  'init.backend.claudeHint': 'recommended, for Claude subscription',
  'init.backend.piLabel': 'PI',
  'init.backend.piHint': 'for other subscription',

  // ── Platform selection ──
  'init.platform.prompt': 'Which interaction platform(s) would you like to use? (space to toggle, enter to confirm, leave empty to skip)',
  'init.platform.slackLabel': 'Slack',
  'init.platform.slackHint': 'recommended',
  'init.platform.feishuLabel': 'Feishu (飞书)',

  // ── Machine identity ──
  'init.machine.prompt': 'Machine name for this device:',
  'init.machine.required': 'Machine name is required.',
  'init.machine.gpuDetected': 'Detected ${count} NVIDIA GPU(s)',
  'init.machine.gpuNone': 'No NVIDIA GPU detected (gpuCount=0)',

  // ── Gateway usage ──
  'init.gateway.note': [
    'Cortex includes an open-source local gateway that proxies all',
    'LLM calls, providing multi-key rotation, automatic failover,',
    'and per-request cost tracking.',
    '',
    'You can optionally share anonymous token usage with aistatus.cc,',
    'an AI model status monitoring site. Your token usage will appear',
    'on the public leaderboard (name + org + token counts). Email is',
    'used only as an identity key and is never displayed.',
    '',
    'Learn more: https://aistatus.cc',
  ].join('\n'),
  'init.gateway.noteTitle': 'Gateway & aistatus',
  'init.gateway.enablePrompt': 'Enable token usage reporting to aistatus?',
  'init.gateway.namePrompt': 'Name:',
  'init.gateway.namePlaceholder': 'your name',
  'init.gateway.orgPrompt': 'Organization:',
  'init.gateway.orgPlaceholder': 'your organization',
  'init.gateway.emailPrompt': 'Email (identity only, not displayed):',
  'init.gateway.emailPlaceholder': 'you@example.com',

  // ── Service registration prompt ──
  'init.serviceRegister.prompt': 'Register Cortex as a system service (auto-start on boot)?',

  // ── Gateway & profile auto-setup ──
  'init.gatewaySetup.overwritePrompt': 'Existing `plan` or `execute` profile detected. Overwrite with a new selection?',
  'init.gatewaySetup.planPrompt': 'Pick model for the `plan` profile (used by executor agents — planner, doc-writer, coder, etc.):',
  'init.gatewaySetup.executePrompt': 'Pick model for the `execute` profile (used by reviewer agents — reviewer, doc-reviewer, coder-reviewer, etc.):',
  'init.gatewaySetup.planFallbackPrompt': 'Pick fallback models for `plan` (in order, space to toggle, enter to confirm, leave empty for no fallback):',
  'init.gatewaySetup.executeFallbackPrompt': 'Pick fallback models for `execute` (in order, space to toggle, enter to confirm, leave empty for no fallback):',
  'init.gatewaySetup.extraProfilesPrompt': 'Pick additional models to register as standalone profiles (profile name = model name, space to toggle, enter to confirm, leave empty to skip):',
  'init.gatewaySetup.noBackends': 'No backends discovered. Make sure you have logged into Claude Code and/or PI first.',
  'init.gatewaySetup.rerunHint': 'You can re-run detection later with: cortex setup-gateway',
  'init.gatewaySetup.discovered': 'Discovered ${count} endpoint modes:\n${summary}',
  'init.gatewaySetup.gatewayWritten': 'Gateway config written to ${path}',
  'init.gatewaySetup.preservedModes': 'Preserved ${count} existing gateway mode(s) that discovery did not report: ${list}',
  'init.gatewaySetup.preservedModesHint': 'If these should have been auto-detected, check `cortex auth status`, log the provider in, and re-run.',
  'init.gatewaySetup.profilesWritten': 'Profiles written to ${path}',
  'init.gatewaySetup.generatedProfiles': 'Generated profiles: ${names} (default: ${default})',
  'init.gatewaySetup.profileIssues': '${count} profile(s) reference a gateway mode that is not configured:\n${lines}',
  'init.gatewaySetup.profileIssuesHint': 'These would fail at runtime with "Unknown mode". Add the mode to gateway.yaml or fix the profile.',

  // ── Local Web UI endpoint (desktop app setup) ──
  'init.localUi.enabled': 'Local Web UI endpoint enabled at ${url}',

  // ── Gateway & profile setup note + readiness loop ──
  'init.gatewayProfile.note': [
    'Cortex can auto-detect your Claude Code and PI configurations',
    'to generate gateway.yaml and profiles.json automatically.',
    '',
    'Make sure you have logged into:',
    '${loginHints}',
  ].join('\n'),
  'init.gatewayProfile.noteTitle': 'Gateway & Profile Setup',
  'init.gatewayProfile.readyPrompt': 'Have you logged in and are ready to auto-detect?',
  'init.gatewayProfile.loginNow': 'Please log in now. Once done, come back and select "Yes".\n${loginHints}',
  'init.gatewayProfile.actionPrompt': 'What would you like to do?',
  'init.gatewayProfile.retryLabel': "I've logged in, retry detection",
  'init.gatewayProfile.skipLabel': 'Skip for now (run `cortex setup-gateway` later)',
  'init.gatewayProfile.skipped': 'Skipped. Run `cortex setup-gateway` later to auto-configure.',

  // ── Outro ──
  'init.outro': 'Cortex initialized at ${dataDir}. Run `cortex daemon` to launch.',

  // ── Git ──
  'init.git.required': 'Git is required but was not found on your system.',
  'init.git.initFailed': 'git init failed: ${message}',
  'init.git.autoInstalling': 'Attempting automatic git installation...',
  'init.git.installed': 'Git installed successfully.',
  'init.git.notOnPath': 'Git was installed but is not on PATH. You may need to restart your shell.',
  'init.git.autoInstallFailed': 'Automatic installation failed.',
  'init.git.manualHint': 'Please install git manually:  ${hint}',

  // ── config output (formatConfigOutput) ──
  'init.config.title': 'Cortex configuration:',
  'init.config.statusTitle': 'Status:',
  'init.config.initialized': 'initialized',
  'init.config.notInitialized': 'not initialized',
  'init.config.found': 'found',
  'init.config.missing': 'missing',
} as const;

export const initZh: Record<keyof typeof initEn, string> = {
  // ── Clipboard / manifest copy prompt ──
  'init.clipboard.prompt': '\n按 "c" 将清单复制到剪贴板（按其他任意键跳过）...',
  'init.clipboard.copied': '清单已复制到剪贴板！',
  'init.clipboard.failed': '无法复制。如果在终端中运行，请确保已启用 OSC 52。',
  'init.clipboard.manual': '清单文本已显示在上方——请手动复制。',

  // ── Backend install ──
  'init.backend.alreadyInstalled': '${label} 已安装。',
  'init.backend.bundled': '${label} 随 Cortex 内置并在进程内运行——无需安装。',
  'init.backend.installing': '正在安装 ${label}...',
  'init.backend.installed': '${label} 安装成功。',
  'init.backend.installFailed': '安装 ${label} 失败。',
  'init.backend.installFailedHint': '安装失败。请手动安装：${command}',
  'init.backend.loginHint.claude': '运行 `claude login` 进行认证。',
  'init.backend.loginHint.pi': '在 Cortex 网页端（设置 > 账号）或聊天里的 `!login pi` 登录 PI 服务提供商；用 `cortex auth status` 验证。',
  'init.backend.label.claude': 'Claude Code',
  'init.backend.label.pi': 'PI',

  // ── Service registration ──
  'init.service.launchdWritten': 'launchd plist 已写入 ${path}',
  'init.service.launchdStartHint': '立即启动：launchctl load ${path}',
  'init.service.systemdUserWritten': 'systemd 单元已写入 ${path}',
  'init.service.systemdUserEnableHint': '启用方法：systemctl --user enable --now cortex（如需登出后继续运行，再执行 loginctl enable-linger）',
  'init.service.systemdInstalled': 'systemd 单元已安装到 ${path}',
  'init.service.systemdEnableHint': '启用方法：sudo systemctl enable --now cortex',
  'init.service.systemInstallFailed': '安装系统服务失败：${message}',
  'init.service.noSudo': '没有 sudo 权限。服务文件已保存到本地。',
  'init.service.manualInstallHint': '手动安装方法：\n  sudo cp ${localPath} ${systemPath}\n  sudo systemctl daemon-reload\n  sudo systemctl enable --now cortex',
  'init.service.unsupported': '不支持在 ${platform} 上注册服务。请使用 `cortex daemon` 手动启动 Cortex。',

  // ── Cancel ──
  'init.cancel': '初始化已取消。',

  // ── Slack setup ──
  'init.slack.manifestTitle': 'Slack 应用清单 —— 创建应用时复制并粘贴',
  'init.slack.guide': [
    '要设置 Slack，你需要一个 Slack 应用：',
    '',
    '1. 访问 https://api.slack.com/apps',
    '2. 点击 "Create New App" → "From a manifest"',
    '3. 选择你的工作区，然后粘贴清单（如上所示）',
    '4. 进入 "Basic Information" → 复制 Signing Secret',
    '5. 在 Basic Information 下，生成一个 App-Level Token',
    '   （作用域：connections:write，命名为 "cortex-socket"）',
    '6. 进入 "OAuth & Permissions" → Install to Workspace',
    '   安装后复制 *Bot User OAuth Token*',
    '7. 进入 "App Home" → Show Tabs → 启用 *Messages Tab*',
    '   并勾选 "Allow users to send messages from the messages tab"',
    '   （DM 支持所必需）',
    '',
    '清单中包含 socket_mode_enabled，因此导入时',
    'Socket Mode 会自动启用。',
    '',
    '所需的 Bot Token 作用域（已包含在清单中）：',
    '  chat:write, im:history, im:write, reactions:read, reactions:write,',
    '  users:read, commands, app_mentions:read,',
    '  channels:history, channels:read, groups:history,',
    '  files:read, files:write, emoji:read, pins:read, pins:write',
  ].join('\n'),
  'init.slack.guideTitle': 'Slack 应用设置指南',
  'init.slack.prefillFound': '发现已有的 Slack 配置。按回车跳过，或输入任意内容重新填写。',
  'init.slack.skipPrompt': '跳过 Slack 配置？（回车 = 跳过，任意键 + 回车 = 重新填写）',
  'init.slack.skipPlaceholder': '按回车跳过',
  'init.slack.signingSecretPrompt': '步骤 1/3：SLACK_SIGNING_SECRET（来自 Basic Information）：',
  'init.slack.signingSecretRequired': '需要填写 Signing Secret。',
  'init.slack.appTokenPrompt': '步骤 2/3：SLACK_APP_TOKEN（App-Level Token，以 xapp- 开头）：',
  'init.slack.appTokenRequired': '需要填写 App Token。',
  'init.slack.appTokenPrefix': 'Token 应以 xapp- 开头',
  'init.slack.botTokenPrompt': '步骤 3/3：SLACK_BOT_TOKEN（Bot User OAuth Token，以 xoxb- 开头）：',
  'init.slack.botTokenRequired': '需要填写 Bot Token。',
  'init.slack.botTokenPrefix': 'Token 应以 xoxb- 开头',

  // ── Feishu setup ──
  'init.feishu.guide': [
    '要设置飞书，请创建一个飞书应用：',
    '',
    '1. 访问 https://open.feishu.cn/app',
    '2. 点击 "Create Agentic App"（创建agentic应用）',
    '3. 输入应用名称（例如 CortexAgent），选择头像，然后点击创建',
    '4. 创建后，页面会显示 App ID 和 App Secret —— 直接复制即可',
    '5. 启用机器人事件并订阅：im.message.receive_v1',
    '',
    'MCP 文档操作（docx/wiki/bitable/sheets/drive）的身份：',
    '  - bot：文档由应用创建/拥有（默认）',
    '  - user：文档由你的飞书账号创建/拥有（推荐）',
  ].join('\n'),
  'init.feishu.guideTitle': '飞书应用设置指南',
  'init.feishu.appIdPrompt': 'FEISHU_APP_ID：',
  'init.feishu.appIdRequired': '需要填写 App ID。',
  'init.feishu.appSecretPrompt': 'FEISHU_APP_SECRET：',
  'init.feishu.appSecretRequired': '需要填写 App Secret。',
  'init.feishu.domainPrompt': 'FEISHU_DOMAIN（可选，"feishu" 或 "lark"）：',
  'init.feishu.domainPlaceholder': 'feishu（留空使用默认值）',
  'init.feishu.authModePrompt': 'MCP 文档操作的身份：',
  'init.feishu.authModeBotLabel': 'bot',
  'init.feishu.authModeBotHint': '文档由应用拥有',
  'init.feishu.authModeUserLabel': 'user（推荐）',
  'init.feishu.authModeUserHint': '文档由你的飞书账号拥有',
  'init.feishu.loginStarting': '正在启动飞书用户登录（OAuth 设备流程）...',
  'init.feishu.loginComplete': '飞书用户登录完成。',
  'init.feishu.loginIncomplete': '飞书用户登录未完成。稍后用 `cortex feishu login` 重试。',

  // ── Intro / backend selection ──
  'init.intro': 'Cortex 设置',
  'init.backend.noteBody': 'Claude Code 和 PI 都支持通过 API 密钥访问任意模型。',
  'init.backend.noteTitle': '后端信息',
  'init.backend.prompt': '你想使用哪些后端？',
  'init.backend.claudeLabel': 'Claude Code',
  'init.backend.claudeHint': '推荐，适用于 Claude 订阅',
  'init.backend.piLabel': 'PI',
  'init.backend.piHint': '适用于其他订阅',

  // ── Platform selection ──
  'init.platform.prompt': '你想使用哪些交互平台？（空格切换，回车确认，留空跳过）',
  'init.platform.slackLabel': 'Slack',
  'init.platform.slackHint': '推荐',
  'init.platform.feishuLabel': 'Feishu (飞书)',

  // ── Machine identity ──
  'init.machine.prompt': '此设备的机器名称：',
  'init.machine.required': '需要填写机器名称。',
  'init.machine.gpuDetected': '检测到 ${count} 块 NVIDIA GPU',
  'init.machine.gpuNone': '未检测到 NVIDIA GPU（gpuCount=0）',

  // ── Gateway usage ──
  'init.gateway.note': [
    'Cortex 内置一个开源本地网关，为所有 LLM 调用提供代理，',
    '支持多密钥轮换、自动故障转移，',
    '以及按请求的成本跟踪。',
    '',
    '你可以选择将匿名 token 使用量分享给 aistatus.cc，',
    '这是一个 AI 模型状态监控网站。你的 token 使用量将',
    '显示在公开排行榜上（名称 + 组织 + token 计数）。邮箱',
    '仅用作身份标识，绝不会被展示。',
    '',
    '了解更多：https://aistatus.cc',
  ].join('\n'),
  'init.gateway.noteTitle': 'Gateway 与 aistatus',
  'init.gateway.enablePrompt': '启用向 aistatus 报告 token 使用量？',
  'init.gateway.namePrompt': '名称：',
  'init.gateway.namePlaceholder': '你的名称',
  'init.gateway.orgPrompt': '组织：',
  'init.gateway.orgPlaceholder': '你的组织',
  'init.gateway.emailPrompt': '邮箱（仅用于身份标识，不会展示）：',
  'init.gateway.emailPlaceholder': 'you@example.com',

  // ── Service registration prompt ──
  'init.serviceRegister.prompt': '将 Cortex 注册为系统服务（开机自启）？',

  // ── Gateway & profile auto-setup ──
  'init.gatewaySetup.overwritePrompt': '检测到已有的 `plan` 或 `execute` 配置。是否用新的选择覆盖？',
  'init.gatewaySetup.planPrompt': '为 `plan` 配置选择模型（由执行类代理使用 —— planner、doc-writer、coder 等）：',
  'init.gatewaySetup.executePrompt': '为 `execute` 配置选择模型（由审查类代理使用 —— reviewer、doc-reviewer、coder-reviewer 等）：',
  'init.gatewaySetup.planFallbackPrompt': '为 `plan` 选择回退模型（按顺序，空格切换，回车确认，留空表示无回退）：',
  'init.gatewaySetup.executeFallbackPrompt': '为 `execute` 选择回退模型（按顺序，空格切换，回车确认，留空表示无回退）：',
  'init.gatewaySetup.extraProfilesPrompt': '选择要注册为独立配置的其他模型（配置名 = 模型名，空格切换，回车确认，留空跳过）：',
  'init.gatewaySetup.noBackends': '未发现任何后端。请确保你已先登录 Claude Code 和/或 PI。',
  'init.gatewaySetup.rerunHint': '你可以稍后用以下命令重新检测：cortex setup-gateway',
  'init.gatewaySetup.discovered': '发现 ${count} 个端点模式：\n${summary}',
  'init.gatewaySetup.gatewayWritten': '网关配置已写入 ${path}',
  'init.gatewaySetup.preservedModes': '保留了 ${count} 个发现过程未报告的现有网关模式：${list}',
  'init.gatewaySetup.preservedModesHint': '如果这些本应被自动检测到，请检查 `cortex auth status`、登录对应 provider 后重新运行。',
  'init.gatewaySetup.profilesWritten': '配置已写入 ${path}',
  'init.gatewaySetup.generatedProfiles': '已生成配置：${names}（默认：${default}）',
  'init.gatewaySetup.profileIssues': '${count} 个配置引用了未配置的网关模式：\n${lines}',
  'init.gatewaySetup.profileIssuesHint': '这些在运行时会因 "Unknown mode" 而失败。请将该模式添加到 gateway.yaml，或修正该配置。',

  // ── Local Web UI endpoint (desktop app setup) ──
  'init.localUi.enabled': '本机 Web UI 端点已启用：${url}',

  // ── Gateway & profile setup note + readiness loop ──
  'init.gatewayProfile.note': [
    'Cortex 可以自动检测你的 Claude Code 和 PI 配置，',
    '以自动生成 gateway.yaml 和 profiles.json。',
    '',
    '请确保你已登录：',
    '${loginHints}',
  ].join('\n'),
  'init.gatewayProfile.noteTitle': 'Gateway 与 Profile 设置',
  'init.gatewayProfile.readyPrompt': '你是否已登录并准备好自动检测？',
  'init.gatewayProfile.loginNow': '请现在登录。完成后回来选择 "Yes"。\n${loginHints}',
  'init.gatewayProfile.actionPrompt': '你想做什么？',
  'init.gatewayProfile.retryLabel': '我已登录，重试检测',
  'init.gatewayProfile.skipLabel': '暂时跳过（稍后运行 `cortex setup-gateway`）',
  'init.gatewayProfile.skipped': '已跳过。稍后运行 `cortex setup-gateway` 自动配置。',

  // ── Outro ──
  'init.outro': 'Cortex 已在 ${dataDir} 初始化。运行 `cortex daemon` 启动。',

  // ── Git ──
  'init.git.required': '需要 Git，但在你的系统上未找到。',
  'init.git.initFailed': 'git init 失败：${message}',
  'init.git.autoInstalling': '正在尝试自动安装 git...',
  'init.git.installed': 'Git 安装成功。',
  'init.git.notOnPath': 'Git 已安装但不在 PATH 中。你可能需要重启 shell。',
  'init.git.autoInstallFailed': '自动安装失败。',
  'init.git.manualHint': '请手动安装 git：  ${hint}',

  // ── config output (formatConfigOutput) ──
  'init.config.title': 'Cortex 配置：',
  'init.config.statusTitle': '状态：',
  'init.config.initialized': '已初始化',
  'init.config.notInitialized': '未初始化',
  'init.config.found': '已找到',
  'init.config.missing': '缺失',
};
