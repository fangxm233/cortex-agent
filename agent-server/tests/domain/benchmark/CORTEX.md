一旦此文件夹有文件变化，请更新我

Benchmark policy tests cover compile-time validation, frozen identity, and stable projections.

| filename | role | function |
|---|---|---|
| accounting-reconciliation.test.ts | 测试 | 验证标记联合、纯度、容差、未记账角色与操作数对齐 |
| actor-capability.test.ts | 测试 | 验证令牌铸造、永久失效、顺序和作用域边界 |
| attempt-record.test.ts | 测试 | 验证 39 成员齐备、13 类封闭边、标识铸造与线程标识双条件 |
| composite-runtime-ports.test.ts | 测试 | 验证 23 端口齐备、六个仅声明端口的接线与 31 号未绑定拒绝；§19.12.1/§19.12.7 提案联合接线点 pin、claimTarget 与生产 mutator 工厂对冻结接口/代理视图的可赋值性 |
| isolation-literals.test.ts | 测试 | X12 权威载体：Gate 5 各模块不得出现 webhook 字面量 |
| isolation-rules.test.ts | 测试 | 验证十三条规则形状、已交付层规则未变，并钉住每条计数 |
| composite-manifest.test.ts | 测试 | 双向验证规范形式、账目原样放置与每条命名码的拒绝 |
| guard-lease-state.test.ts | 测试 | 验证守卫表按角色类编译、选择器每步取自实时租约 |
| lease-echo.test.ts | 测试 | 验证回声文档、控制路由投递与拒绝传播 |
| settings-snapshot.test.ts | 测试 | 验证冻结记录、缺键抛出、一次性捕获与无重载 |
| task-broker-arguments.test.ts | 测试 | 验证十个入口的严格参数模式与码点边界 |
| task-broker.test.ts | 测试 | 验证十动作守卫、类型化拒绝和投影隔离；§19.12.2 两腿 claim（requester 货币、严格可执行未认领后代、铸币前拒绝）、§19.12.1/§19.12.6 提案联合按字面 success:false 收窄与 typedPortFailure 按 reason 匹配 |
| trial-acceptance-ledger.test.ts | 测试 | 验证严格台账形状、旧格式例外和生产能力接线 |
| trial-task-mutator.test.ts | 测试 | §19.12.8 R2-T1…R2-T18 契约：真实生产三工厂链（P2 委托与文件、P4 锁表/作用域、生产铸币/注册、真实提案存储、真实 broker），每个方法一条生产工厂测试、C1-C5 围栏零副作用、两腿 claim、unclaim 释放权威、spawn 语义、edit 的 R1 主语、提案精确对象与 42 号、并发序列等价、md5/唯一铸币/无第二令牌钉 |
| port-scope-fence.test.ts | 测试 | 验证 I3 出域即抛 32 号、守护进程回退不变、围栏随试验起落 |
| trial-task-ports.test.ts | 测试 | 验证 git 截断、P4 接线、realpath 约束及守护进程回归 |
| policy-backed-runtime-deps.test.ts | 测试 | 验证冻结解析与运行时拒绝 |
| policy-compiler.test.ts | 测试 | 验证 arm 编译、分发、调用一致性与投影 |
| proposal-seal.test.ts | 测试 | 验证四状态、S1-S4 合取的 16 组子集、V1-V4、十字段行、42 号失败即关闭与回调规则，以及两类边经真实校验器解析为零未决端点 |
| terminal-predicate.test.ts | 测试 | 验证 D2/C7 各合取分别求值、Agent/Task 普查不可空过、非 explicit 链接来源即 fail（§9.3 M1）、41 号按整数断言 |
| trial-task-dispatcher.test.ts | 测试 | 验证 P9 试验调度：选任务/铸造代次/提示，主机锁、GPU、限流缺失与接线；§19.12.2 唯一代次铸币 mintTrialDispatchGeneration 与 createDispatcherOwnedClaimTarget 生产回调工厂（单目标能力铸币/注册、拒绝即失效令牌） |
| trial-clock.test.ts | 测试 | 验证注入时源、D5 截止边界、单调起点与 sleep 取消 |
| trial-adapter-factory.test.ts | 测试 | 验证试验适配器构造、守卫传输、MCP 预算与环境隔离 |
| trial-adapter-pi.test.ts | 测试 | 验证 PI 试验构造、环境无关性与严格 MCP 组合 |
| trial-thread-adapter.test.ts | 测试 | 验证每步适配器取用哪些字段、逐一比对分叉两侧 |
| trial-thread-policy-fixture.ts | 夹具 | 按变体为线程各槽位编译 coder-review 试验策略 |
| variant-proposal.test.ts | 测试 | 验证封闭判定表、完成守卫与五类阻塞理由 |
| workspace-lease.test.ts | 测试 | 验证租约状态、放置表、快照与步边界结算 |
