一旦此文件夹有文件变化，请更新我

Benchmark policy boundary validates declared arms and freezes all resolved trial inputs.

| filename | role | function |
|---|---|---|
| accounting-reconciliation.ts | 核心 | 比对代理与日志账目，缺失一律标记不可用 |
| arm-schema.ts | 类型 | 校验 v2 arm 与版本化 phase-A 输入 |
| capabilities.ts | 策略 | 派生封闭模板与能力白名单 |
| decimal-text.ts | 工具 | 以整数单位做精确十进制解析与比较 |
| lease-echo.ts | 核心 | 用容器时钟组成并投递凭据租约回声 |
| policy-backed-runtime-deps.ts | 策略 | 仅从冻结快照解析运行时名称 |
| policy-compiler.ts | 核心 | 有序解析资产并编译冻结策略 |
| resolved-policy.ts | 类型 | 定义策略值与 1–44 失败分类 |
| trial-adapter-factory.ts | 核心 | 仅从冻结策略构造每次试验的适配器 |
| trial-thread-adapter.ts | 核心 | 为线程每一步构造并关闭一个试验适配器 |
| variant-proposal.ts | 核心 | 由流水线线程自身的记录判定提案，只决定不执行 |
| workspace-lease.ts | 核心 | 单写者工作区租约、每步放置与步边界结算 |
