一旦此文件夹有文件变化，请更新我

Benchmark policy boundary validates declared arms and freezes all resolved trial inputs.

| filename | role | function |
|---|---|---|
| accounting-reconciliation.ts | 核心 | 比对代理与日志账目，缺失一律标记不可用 |
| actor-capability-scope.ts | 核心 | 持有不可复活的令牌表并解析通道与作用域能力 |
| arm-schema.ts | 类型 | 校验 v2 arm 与版本化 phase-A 输入 |
| attempt-record.ts | 类型 | 定义 39 成员尝试记录、13 类边与尝试标识铸造 |
| capabilities.ts | 策略 | 派生封闭模板与能力白名单；§8.2 ActorCapability 令牌与铸币（S-B，唯一定义） |
| composite-runtime-ports.ts | 类型 | 冻结 §7.2 全部 23 个端口，未绑定端口抛 31 号，六个仅声明端口接线到已交付实现；cap 参数已接入 ActorCapability；接线 P2/P4/P5、P6 与 P9 工厂；§19.12.1 提案联合（ProposalMutationResult）结构性重导出与接线点 pin |
| trial-task-mutator.ts | 核心 | §19.12 修正后的 P3 能力感知任务变更器：七个同步方法、C1-C5 围栏、两腿 claim 的目标腿、AttemptReleaseAuthority 门控的 unclaim、提案联合与记录入口（仅导入 Node 内建与 ./capabilities.js） |
| trial-task-ports.ts | 核心 | 实现 git 截断、试验锁作用域和 realpath 约束的工件投影 |
| composite-manifest.ts | 核心 | 编码复合清单规范形式并按命名码校验 DAG 不变量 |
| decimal-text.ts | 工具 | 以整数单位做精确十进制解析与比较 |
| lease-echo.ts | 核心 | 用容器时钟组成并投递凭据租约回声 |
| policy-backed-runtime-deps.ts | 策略 | 仅从冻结快照解析运行时名称 |
| policy-compiler.ts | 核心 | 有序解析资产并编译冻结策略 |
| proposal-seal.ts | 核心 | 持有提案存储与封存判定：S1-S4 合取、V1-V3 失效、失败即关闭的读取与两类边投影 |
| resolved-policy.ts | 类型 | 定义策略值与 1–44 失败分类 |
| settings-snapshot.ts | 类型 | 编译期一次性冻结设置记录，缺键即抛，无磁盘读取与热重载 |
| task-broker-arguments.ts | 核心 | 严格校验十个代理入口的 G5-W5 参数模式 |
| task-broker.ts | 核心 | 执行十动作授权、类型化拒绝与隔离任务投影；§19.12 两腿 claim（claimTarget 回调路由、严格可执行未认领后代守卫）与提案联合按字面 success:false 收窄（33→R8、34→R1） |
| trial-acceptance-ledger.ts | 核心 | 严格读取试验台账并写入判决、替代和重投状态 |
| terminal-predicate.ts | 核心 | 评估 §9.4 每模式清单（D2/C7 三合取，含链接来源与原生子代理普查），失败即抛出 41 号拒绝 |
| trial-task-dispatcher.ts | 核心 | 试验内调度：P9 选任务/铸造代次/组装提示，无主机锁、GPU 与限流耦合；唯一代次铸币 mintTrialDispatchGeneration 与 dispatcher 所有的 claim 回调工厂 createDispatcherOwnedClaimTarget（目标能力铸币/注册/失效） |
| trial-clock.ts | 类型 | 零依赖确定性时钟：墙钟、单调纳秒、截止余量与可取消 sleep |
| trial-adapter-factory.ts | 核心 | 仅从冻结策略构造每次试验的适配器 |
| trial-thread-adapter.ts | 核心 | 为线程每一步构造并关闭一个试验适配器 |
| variant-proposal.ts | 核心 | 由流水线线程自身的记录判定提案，只决定不执行 |
| workspace-lease.ts | 核心 | 单写者工作区租约、每步放置与步边界结算 |
