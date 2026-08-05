一旦此文件夹有文件变化，请更新我

Benchmark policy tests cover compile-time validation, frozen identity, and stable projections.

| filename | role | function |
|---|---|---|
| accounting-reconciliation.test.ts | 测试 | 验证标记联合、纯度、容差与未记账角色 |
| lease-echo.test.ts | 测试 | 验证回声文档、控制路由投递与拒绝传播 |
| policy-backed-runtime-deps.test.ts | 测试 | 验证冻结解析与运行时拒绝 |
| policy-compiler.test.ts | 测试 | 验证 arm 编译、分发、调用一致性与投影 |
| trial-adapter-factory.test.ts | 测试 | 验证试验适配器构造、守卫传输、MCP 预算与环境隔离 |
| trial-adapter-pi.test.ts | 测试 | 验证 PI 试验构造、环境无关性与严格 MCP 组合 |
| trial-thread-adapter.test.ts | 测试 | 验证每步适配器取用哪些字段、逐一比对分叉两侧 |
| trial-thread-policy-fixture.ts | 夹具 | 按变体为线程各槽位编译 coder-review 试验策略 |
| variant-proposal.test.ts | 测试 | 验证封闭判定表、完成守卫与五类阻塞理由 |
| workspace-lease.test.ts | 测试 | 验证租约状态、放置表、快照与步边界结算 |
