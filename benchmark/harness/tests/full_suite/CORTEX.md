一旦此文件夹有文件变化，请更新我

Full-suite tests verify strict pins, bounded scheduling, private configs and zero-provider preflight.

| filename | role | function |
|---|---|---|
| __init__.py | 入口 | 隔离 full-suite test module namespace |
| test_cli.py | 测试 | 验证 CLI help 与 structured JSON |
| test_failure_isolation.py | 测试 | 验证单 task 失败、dummy 泄漏与 provider 中断不牵连整轮 |
| test_config.py | 测试 | 验证 suite readiness 与 89/87 task pins |
| test_network.py | 测试 | 验证 container-before-network cleanup |
| test_preflight.py | 测试 | 验证 zero-provider host preflight |
| test_runner.py | 测试 | 验证 routes、trial result 与结果顺序 |
| test_scheduler.py | 测试 | 验证并发上界与 no-rerun ledger |
| test_task_job.py | 测试 | 验证单 task Harbor config 与 env |
