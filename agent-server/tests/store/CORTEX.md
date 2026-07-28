一旦此文件夹有文件变化，请更新我

Store 与持久化原语的隔离回归测试。

| filename | role | function |
|---|---|---|
| conversation-history-repo.test.ts | 测试 | 覆盖 notice 保留、历史追加、source-id 幂等、DEBUG 关联与截断 |
| pending-injection-repo.test.ts | 测试 | 覆盖 pending record 持久化、并发、隔离与移除 |
| cost-repo.test.ts | 测试 | 覆盖成本记录并发与预算读写 |
| execution-repo.test.ts | 测试 | 覆盖执行记录并发、索引一致性与 re-export 状态委托；不做导出清单断言 |
| hook-sync.test.ts | 测试 | 覆盖托管 hook 同步策略 |
| json-repository.test.ts | 测试 | 覆盖 JSON repository 并发与缓存 |
| outbound-queue.test.ts | 测试 | 覆盖出站 WAL 队列恢复与清理 |
| plugin-sync.test.ts | 测试 | 覆盖 plugin 版本同步策略 |
| profile-repo.test.ts | 测试 | 覆盖 profile 缓存、并发与热更新 |
| project-dir-repo.test.ts | 测试 | 覆盖项目目录映射持久化 |
| schedule-repo.test.ts | 测试 | 覆盖日程存储并发与 CRUD |
| session-registry-repo.test.ts | 测试 | 覆盖 registry 缓存与 context snapshot 设置/清除 |
| session-store.test.ts | 测试 | 覆盖 session store 行为 |
| task-repo.test.ts | 测试 | 覆盖任务存储锁、序列化、flush 与端到端持久化；不做方法清单断言 |
| version-migrations.test.ts | 测试 | 覆盖版本迁移幂等与文本迁移 |
