一旦此文件夹有文件变化，请更新我

Agent-server 进程与 CLI 入口；负责组合依赖并启动运行时边界。

| filename | role | function |
|---|---|---|
| app.ts | 入口 | 组合并启动 agent server 与可选 Web UI |
| cli.ts | 入口 | Cortex CLI 命令分发 |
| daemon.ts | 入口 | 守护进程监督与热重启 |
| doctor-cli.ts | 入口 | 运行环境诊断 CLI |
| feishu-login.ts | 入口 | 飞书登录辅助流程 |
| init.ts | 入口 | 初始化用户目录与配置 |
| start-ui-http.ts | 适配 | 绑定 UI service 到 HTTP/SSE 服务 |
| startup-helpers.ts | 工具 | 启动前日志清理与 MCP 配置准备 |
| startup-notify.ts | 适配 | 发送启动与重启通知 |
| ui-http-gate.ts | 适配 | 按环境变量延迟加载 Web UI transport |
