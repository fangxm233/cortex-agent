一旦此文件夹有文件变化，请更新我

Commission（长任务）领域逻辑：路径/slug、注入上下文、批准落地与 decision 投影。

| filename | role | function |
|---|---|---|
| commission-paths.ts | 工具 | slug 规则与 commission 目录路径解析 |
| commission-context.ts | 核心 | 加载 [Commission] 注入块的合约与账本摘要 |
| commission-draft.ts | core | Resolves create-time commission mode: draft dir creation and join validation |
| commission-finalize.ts | 核心 | 批准时改名草稿目录、注册并绑定 session |
| decision-projection.ts | 核心 | 把 send_decision 流量镜像进 decisions.jsonl 并发 SSE 提示 |
