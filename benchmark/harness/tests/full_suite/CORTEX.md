一旦此文件夹有文件变化，请更新我

Full-suite tests verify strict pins, bounded scheduling, private configs and zero-provider preflight.

| filename | role | function |
|---|---|---|
| __init__.py | 入口 | 隔离 full-suite test module namespace |
| test_cli.py | 测试 | 验证 CLI help 与 structured JSON |
| test_config.py | 测试 | 验证 suite spec 与 89 task inventory |
| test_network.py | 测试 | 验证 container-before-network cleanup |
| test_preflight.py | 测试 | 验证 zero-provider host preflight |
| test_runner.py | 测试 | 验证 task-owned routes 与结果顺序 |
| test_scheduler.py | 测试 | 验证并发上界与 no-rerun ledger |
| test_task_job.py | 测试 | 验证单 task Harbor config 与 env |
