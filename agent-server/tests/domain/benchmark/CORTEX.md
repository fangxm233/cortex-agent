一旦此文件夹有文件变化，请更新我

Benchmark policy tests cover compile-time validation, frozen identity, and stable projections.

| filename | role | function |
|---|---|---|
| policy-backed-runtime-deps.test.ts | 测试 | 验证冻结解析与运行时拒绝 |
| policy-compiler.test.ts | 测试 | 验证 arm 编译、分发、调用一致性与投影 |
| trial-adapter-factory.test.ts | 测试 | 验证试验适配器构造、守卫传输、MCP 预算与环境隔离 |
| trial-adapter-pi.test.ts | 测试 | 验证 PI 试验构造、环境无关性与严格 MCP 组合 |
| workspace-lease.test.ts | 测试 | 验证租约状态、放置表、快照与步边界结算 |
