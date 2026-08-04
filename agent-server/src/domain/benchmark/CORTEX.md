一旦此文件夹有文件变化，请更新我

Benchmark policy boundary validates declared arms and freezes all resolved trial inputs.

| filename | role | function |
|---|---|---|
| arm-schema.ts | 类型 | 校验 v2 arm 与版本化 phase-A 输入 |
| capabilities.ts | 策略 | 派生封闭模板与能力白名单 |
| policy-backed-runtime-deps.ts | 策略 | 仅从冻结快照解析运行时名称 |
| policy-compiler.ts | 核心 | 有序解析资产并编译冻结策略 |
| resolved-policy.ts | 类型 | 定义策略值与 1–44 失败分类 |
| trial-adapter-factory.ts | 核心 | 仅从冻结策略构造每次试验的适配器 |
