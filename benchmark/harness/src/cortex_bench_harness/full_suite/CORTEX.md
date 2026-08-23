一旦此文件夹有文件变化，请更新我

Full-suite launcher isolates each external task behind its own route, process, network slot and evidence root.

| filename | role | function |
|---|---|---|
| __init__.py | 入口 | 标记 full-suite package |
| cli.py | CLI | 执行 preflight 或显式 paid run |
| config.py | 边界 | 严格解析 suite pins 与 run readiness |
| network.py | 网络 | 分配固定 Docker worker slots |
| pi_agent.py | 适配 | 使用只读挂载的 Node/PI runtime |
| preflight.py | 验证 | 校验 tasks、images、runtime 和 gateway |
| processes.py | 进程 | 跟踪并终止 Harbor process groups |
| runner.py | 核心 | 协调 proxy、Harbor 与 trial result |
| scheduler.py | 调度 | 限制并发并保持结果顺序 |
| state.py | 状态 | 原子记录 no-rerun lifecycle |
| task_job.py | 构建 | 生成单 task Harbor 与 PI config |
| task_proxy.py | 边界 | Arm/finalize 每 task credential route |
