# 计划：Cortex APP 热更新提示（Frontend OTA 就绪提示）

## 背景（已核实事实）

- Cortex 桌面/安卓 app 是 Tauri v2 壳（`desktop/`），加载自更新 SPA（`web/`），走 `cortexui://` scheme 从磁盘读前端目录。
- 现有 OTA 流程（`desktop/src-tauri/src/ota.rs` + `lib.rs`）：
  - 启动时 `promote_staged()` 把上次下载好的 `staged/` 换成 `current/`（下次启动才生效）。
  - 窗口打开后后台线程跑 `check_and_stage()`：拉 manifest → 下载 → sha256 校验 → 解压进 `staged/`。成功返回 `Ok(Some(version))`。
  - **问题**：staged 成功后目前只打了一行日志（`lib.rs:415` "staged frontend update … (applies next launch)"），SPA 完全不知情，用户只能在下次静默启动时才拿到更新。**缺的就是这个"新版本已就绪、重启生效"的提示。**
- Manifest 字段（`agent-server/.../ui-ota.ts` 核实）：`version` 是**内容哈希**（`contentVersion`，非 semver）、`sha256`、`size`（zip 字节数）、`url`。→ 提示只能显示短哈希 + 大小，**不编造 semver 版本号**。
- 设计规范（GROUND TRUTH）：
  - `scheme-mobile.dc.html` §3 / 3a：**精确的「热更新弹窗」**——居中 alert 盖会话列表，图标方块 + 标题「新版本已就绪」+ Plex Mono 版本行 + 说明 + 主按钮「退出 App」(48px 满宽 ink #191C22) + 次按钮「忽略」(44px 纯文字 #8A93A2)。规则：静默下载完成、**无输入焦点、无进行中审批操作**时才弹；「退出 App」立即退出由系统重新拉起生效；「忽略」本次运行内不再弹，下次冷启动自动生效。
  - `scheme.dc.html`：**无**专门的热更新界面。可借鉴的设计语言：18a 系统通知 toast、17a daemon 软/硬重启 modal、12a 「常驻待重启横幅」。桌面端将用 token 化 `design/Modal` 语言承载（无 hex 硬编码，遵循 design/ 规范）。
- 现有可复用基础设施：`features/notifications/os-notify.ts`（Tauri 原生 seam 范式：动态 import / off-shell no-op / 单测 mock）；`design/Modal.tsx`（token 化 Radix Dialog）；挂载点 `shell/AppShell.tsx`（桌面全局 Provider）、`mobile/MobileShell.tsx`（移动全局 Provider）。
- Tauri `withGlobalTauri: true` 已开 → JS 侧可用 `window.__TAURI__.event.listen` / `.core.invoke`，无需新增 `@tauri-apps/api` 依赖（与 init_script 现有用法一致）。

## 目标

app 后台 OTA 下载并 stage 好新前端后，在 SPA 内弹出"新版本已就绪、重启生效"提示；用户可一键应用（桌面重启 / 移动退出待系统重新拉起）或忽略（本次运行内不再弹）。桌面端样式遵循 scheme.dc.html 设计语言，移动端 1:1 遵循 scheme-mobile 3a。

## 改动清单

### A. Rust 壳（`desktop/src-tauri/`）

1. `ota.rs`
   - `Manifest` 增加 `size: u64`（当前被忽略，wire 上已有）。
   - `check_and_stage` 返回类型从 `Option<String>` 改为 `Option<StagedUpdate>`，`StagedUpdate { version, from_version, size }`（`from_version` = stage 前的 `installed_version()`）。
   - 纯逻辑（size 解析、StagedUpdate 组装）加单测。

2. `lib.rs`
   - 后台 OTA 线程额外捕获 `app.handle().clone()`；`check_and_stage` 成功时 `app.emit("frontend-update-staged", payload)`（payload = `{ version, fromVersion, size }`，serde 序列化）。
   - 新增 Tauri command `apply_frontend_update`：桌面 `app.restart()`（进程重启 → 启动时 `promote_staged` 生效）；Android `cfg` 分支走 `app.exit(0)`（对应 3a「退出 App」，由系统重新拉起）。
   - 新增 Tauri command `get_staged_update() -> Option<StagedUpdateInfo>`：读 `store.staged_version()`，存在且 ≠ installed 时返回 `{ version, fromVersion }`（size 无法从磁盘恢复→None）。作为**漏接事件的兜底**（监听器挂载晚于事件、或会话中途已 stage）。
   - 两个 command 注册进 `invoke_handler`。

### B. Web SPA（`web/src/features/hot-update/` 新目录）

1. `frontend-update.ts`（原生 seam，仿 `os-notify.ts`）
   - 类型 `StagedUpdate { version; fromVersion?; size? }`。
   - `onFrontendUpdateStaged(cb): Promise<()=>void>` — `window.__TAURI__.event.listen('frontend-update-staged')`；off-shell no-op。
   - `getStagedUpdate(): Promise<StagedUpdate | null>` — invoke `get_staged_update`；off-shell null。
   - `applyFrontendUpdate(): Promise<void>` — invoke `apply_frontend_update`；off-shell no-op。
   - 纯 helper（单测）：`formatUpdateSize(bytes) → "8.4 MB"`、`shortVersion(v) → v.slice(0,8)`、`versionTransitionLabel(from,to) → "<from8> → <to8>" | "<to8>"`。

2. `useHotUpdate.ts` — hook：mount 时订阅事件 + 查兜底；state `{ staged, dismissed }`；`apply()`→`applyFrontendUpdate()`；`dismiss()`→本次运行内不再弹（内存态，符合 3a「忽略」）。**焦点门禁**：事件到达时若 `document.activeElement` 是 input/textarea/contenteditable，则延迟到 blur 后再显示（对应 3a「无输入焦点时才弹」）。审批进行中门禁作为**已记录的简化**先不做（注释标注 follow-up）。

3. 桌面 `HotUpdateDialog.tsx` + `HotUpdateProvider.tsx`
   - 用 `design/Modal` 承载，token-only（无 hex，遵循 design/ 规范）：图标方块（`pill-run` 淡蓝底 + 上箭头，呼应 18a 的 24px tinted square）+ 标题「新版本已就绪」+ Plex Mono 版本行（`versionTransitionLabel` + size + 已下载）+ 说明「热更新已下载完成，重启 App 后生效。运行中的线程在服务端继续执行，不受重启影响。」+ footer 两钮：主「重启 App」(primary)→`apply()`，次「稍后」(ghost)→`dismiss()`。
   - `HotUpdateProvider` 挂进 `AppShell`。

4. 移动 `MHotUpdateDialog.tsx` + `MHotUpdateProvider.tsx`
   - **1:1 复刻 scheme-mobile 3a**（raw hex，遵循 mobile §8.3 `@ds-adherence-ignore` 约定）：`rgba(25,28,34,.44)` 遮罩、居中白卡 `border-radius:18px` + `box-shadow:0 24px 64px`、46px `#EEF0FA` 图标方块 + `#4655D4` 上箭头 SVG、标题「新版本已就绪」17px/700、Plex Mono 版本行 `#98A1B0`、说明 `#5B6472`、主钮「退出 App」48px 满宽 `#191C22` 白字、次钮「忽略」44px `#8A93A2` 纯文字。
   - 版本行文案：`versionTransitionLabel(from,to) · <size> · 已下载`（size 缺失时省略该段）。
   - 「退出 App」→`apply()`（Android 退出，系统重新拉起生效）；「忽略」→`dismiss()`。
   - `MHotUpdateProvider` 挂进 `MobileShell`。

### C. 测试（遵循 develop/TDD）

- Rust：`ota.rs` 新纯逻辑单测（size 解析、StagedUpdate 组装、manifest 反序列化含 size）。`apply_/get_staged_/emit` 为薄壳，靠 `cargo build`/`cargo test` + 手测覆盖。
- Web：`frontend-update.ts` 纯 helper 单测（size/version 格式化）；`useHotUpdate` 焦点门禁 + dismiss 逻辑单测（mock seam）；桌面 & 移动 Dialog 渲染测试（mock seam，断言标题/版本行/按钮存在且点击触发 apply/dismiss）。
- 新增文件后更新对应目录 `CORTEX.md` 索引（`web/src/features/hot-update/CORTEX.md`、`web/CORTEX.md`、`desktop/CORTEX.md` 的 OTA 段补一句事件/命令、`shell`/`mobile` 挂载说明）。

## 验证

- `pnpm --filter web build`（tsc --noEmit + vite build）EXIT 0；`pnpm --filter web test`（vitest）新增测试全绿。
- `cargo check`（desktop crate）EXIT 0（若本机 Rust 工具链可用；不可用则记录并至少通过 `pnpm --filter web` 全套）。
- 手测路径（记录到 desktop/CORTEX.md）：改一处 SPA → 重新 `pnpm --filter web build` 让 server 端 content hash 变 → 运行中的 app 后台 OTA stage → 观察弹窗出现 → 点主钮验证重启/退出后新版本生效。

## 已确认的决定（用户 2026-07-16 澄清）

1. **桌面端有专门设计**：`scheme.dc.html` §H / **21a 热更新弹窗**（文件末尾 L4692-4766）。桌面端 **1:1 遵循 21a**，不用横幅/toast：
   - 420px 居中 modal，圆角 14，遮罩 `rgba(25,28,34,.44)`，`box-shadow:0 24px 64px rgba(16,24,40,.32)`，padding `20px 20px 16px`。
   - 头部行：36px 圆角方块（radius 10，`#EEF0FA` 底，`#4655D4` 上箭头 SVG）+ 标题「新版本已就绪」(14px/650 `#191C22`) + Plex Mono 版本行 (10.5px/500 `#98A1B0`)。
   - 说明 (12.5px/1.65 `#5B6472`)：「热更新已在后台下载完成，重启 App 后生效。运行中的线程在服务端继续执行，不受重启影响；未发送的草稿会保留。」
   - 按钮右对齐 gap 8：「忽略」ghost（36px，border `#E7E9EE`，`#5B6472`，左）+「重启 App」ink（36px，`#191C22` 白字，右）。
   - 行为：Esc / 点遮罩 = 忽略；焦点/审批门禁同 mobile。
   - 桌面 mobile 均为 app 内设计，token 化不便时按 21a/3a 原始 hex（app 端非 proto 浅色 token 集，与 mobile 同理）。
2. **重启方式**：桌面用 `app.restart()`（方便的重启方法），按钮文案「重启 App」；Android 无可靠 restart → `app.exit(0)`，按钮文案「退出 App」（对应 3a）。
3. **版本号显示哈希**：真实 version 是内容哈希 → 显示短哈希（`v.slice(0,8)`）+ 大小 + 「已下载」，**不编造 semver**。版本行示例：`a3f9c21b → b7e2d90c · 8.4 MB · 已下载`（无 from 时省略箭头段）。
4. **仅 APP 需要，Web 端不弹**：`HotUpdateProvider` / `MHotUpdateProvider` 在 `isNativeShell()` 为 false 时短路，浏览器/ui-http 永不显示（seam off-shell 本就 no-op，Provider 再加一道短路守卫）。

## 影响面 / 风险

- Rust 壳改动需重新构建 APK/桌面包才生效（OTA 只热更 SPA，不热更壳）——首次上线这套提示需要发一次带新壳的包。
- 纯新增功能，不改现有 OTA 成功路径的行为（stage/promote 逻辑不动，只在成功后多发一个事件 + 提供两个只读/动作 command）。off-shell（浏览器/ui-http）全部 no-op，不影响 Web UI。
