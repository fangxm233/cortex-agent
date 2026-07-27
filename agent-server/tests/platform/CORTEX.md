一旦此文件夹有文件变化，请更新我

平台组合、TUI 协议与 Web UI transport 的隔离回归测试。

| filename | role | function |
|---|---|---|
| adapter-factory.test.ts | 测试 | 覆盖 adapter 环境选择与组合 |
| composite-adapter.test.ts | 测试 | 覆盖多平台路由与 marker 生命周期 |
| tui-gateway.test.ts | 测试 | 覆盖 TUI gateway 行为 |
| tui-protocol.test.ts | 测试 | 覆盖 TUI wire protocol |
| tui-transcript.test.ts | 测试 | 覆盖 TUI transcript 转换 |
| ui-http-access-jwt.test.ts | 测试 | 覆盖 Access JWT 鉴权 |
| ui-http-app-router.test.ts | 测试 | 覆盖 tRPC AppRouter 映射 |
| ui-http-lazy-driver.mjs | 工具 | 驱动 transport lazy-load 测试 |
| ui-http-lazy-hooks.mjs | 工具 | 记录 lazy-load module resolve |
| ui-http-lazy-load.test.ts | 测试 | 覆盖 transport 延迟加载 |
| ui-http-same-origin-spa.test.ts | 测试 | 覆盖同源 SPA 托管 |
| ui-http-server.test.ts | 测试 | 覆盖 HTTP/SSE transport |
| ui-http-wiring.test.ts | 测试 | 覆盖 transport composition wiring |
| ui-ota.test.ts | 测试 | 覆盖 desktop UI OTA routes |
| zip-writer.test.ts | 测试 | 覆盖 deterministic ZIP encoder |
