# 客户端发送文件"打不开"修复：PDF/文本内联预览 + 原生下载

## 背景与根因（已确认）

Cortex 发送的文件在客户端（Tauri 桌面 + 安卓）点击无反应。根因不在服务端或文件传输，
而在客户端"打开/下载"这一步用的是纯浏览器机制，在 Tauri WebView 里是空操作：

- 文件字节通过 `GET /api/files/download?path=…`（带 `x-cortex-token`）用 `fetch` 抓取，包成
  blob object URL —— 这一步在 WebView 里正常（tRPC 用同一套鉴权都能通）。
- 问题在拿到 blob 之后的"呈现"：
  - `openFile()` → `window.open(objUrl, '_blank')`（`web/src/lib/files.ts:40-44`）—— WebView 里
    `window.open` 打开 `blob:` 是被拦截/返回 null 的空操作。
  - `downloadFile()` → 造 `<a download>` 再 `.click()`（`files.ts:28-37`）—— 原生 WebView 默认无
    下载管理器，Rust 壳也没注册 download listener，锚点点击被忽略。
- 证据：`desktop/src-tauri/capabilities/default.json` 仅有 `core:default` + `notification:default`，
  无 `opener`/`dialog`/`fs`/`shell` 插件；`lib.rs` 无任何 `setDownloadListener`/`on_download` 接线。
- 图片/视频不受影响：走 `features/media/MediaViewer` 的 lightbox，用 `<img>/<video src=objectUrl>`
  内联渲染，不经过 `window.open` 或下载。坏的只有非媒体的普通文件（PDF / md / txt / csv / json / zip …）。

## 目标（用户指定）

1. **PDF 与文本类文件 → 内联预览**（在 app 内模态里看，像图片/视频那样，绝不新开标签页）。
2. **其他文件 → 下载**（下载在原生 WebView 里也是坏的，需补一条真正能落地的原生下载通道）。

## 关键设计决策

### D1. PDF 必须用 pdf.js，不能用 `<iframe>`

桌面 Linux 的 webkit2gtk 和安卓系统 WebView **都没有内置 PDF 渲染器**，`<iframe src=blob:pdf>`
会空白或触发下载——那正是我们要修的"静默失效"。要在所有 WebView 里可靠内联渲染 PDF，引入
`pdfjs-dist`（纯 JS，页面渲染到 `<canvas>`，可选 WASM 不需要）。

- Vite 接线用最稳的 `?worker` 方式：`import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker'`
  → `GlobalWorkerOptions.workerPort = new PdfWorker()`（避免 `?url` 在 lib 模式被内联成 base64 的坑）。
- PDF 数据直接以 `ArrayBuffer` 传给 `getDocument({ data })`，不经 blob URL，绕开 CSP/协议问题。
- worker 打进 `web/dist`，经 `cortexui://` 同源加载；无原生副作用。首屏不加载，仅打开 PDF 时按需
  `import()`（动态导入，控制主包体积）。

### D2. 文本类无需依赖

`.md/.markdown` 复用已有的手写 Markdown 渲染（`features/memory/markdown.ts` +
`features/workbench/ChatMarkdown.tsx`）；其余文本用等宽 `<pre>` 展示 `fetch().text()` 的内容。

### D3. 分类由扩展名/mimeType 决定

`Attachment.type` 只有 `'image' | 'video' | 'file'`（`transcript-vm.ts:21`），PDF 与文本都归为
`file`。新增纯函数 `doc-kind.ts` 的 `docKindOf(name, mimeType)` → `'pdf' | 'text' | null`：
- `pdf`：扩展名 `.pdf` 或 `mimeType==='application/pdf'`。
- `text`：文本扩展名白名单（md/markdown/txt/log/json/csv/tsv/yaml/yml/xml/html/css/js/ts/tsx/jsx/
  py/rs/go/java/c/cpp/h/sh/toml/ini/env/sql/…）或 `mimeType` 以 `text/` 开头 / 是 `application/json`。
- 其他 → `null`（走下载）。

### D4. 原生下载：新增 Rust app 命令，不加插件、不改 capability

Tauri v2 里 app 自定义 `#[tauri::command]`（注册进 `generate_handler!`）不受 capability/ACL 约束
（现有 `connect`/`disconnect` 等命令在 `default.json` 无对应条目即可调用即为证）。因此新增
`save_download(name, bytes)` 命令只用 `std::fs` + 核心 `path()` API，**无需新插件或权限**：

- 桌面：写入系统下载目录 `app.path().download_dir()`（core path API），返回绝对路径。
- 安卓：`download_dir()` 不可靠 → 写入 `app.path().app_data_dir()/downloads/`（app-private，可经文件
  管理器在 `Android/data/dev.cortex.desktop/` 下取到），并用已装的 notification 插件弹一条"已保存到 …"。
- `lib/files.downloadFile()` 按 `isNativeShell()` 分流：原生壳 → `fetch` 成字节 → `invoke('save_download')`
  → 成功后 toast 路径；浏览器/ui-http 模式 → 保持现有 `<a download>`（那里本就正常）。

安卓公共 Downloads（MediaStore/DownloadManager）需要 Kotlin/JNI，成本高且"其他文件"是长尾，
本次先落 app-private + 通知，作为已知限制记录，后续可迭代。

## 变更清单

### 新增（web）

| 文件 | 作用 |
|---|---|
| `web/src/features/media/doc-kind.ts` + `.test.ts` | 纯函数 `docKindOf(name, mimeType)` / `isDocPreviewable(...)`；TDD 覆盖 pdf/文本白名单/mimeType/大小写/无扩展名/null。 |
| `web/src/features/media/DocViewer.tsx` | `DocViewerProvider` + `useDocViewer().openDoc(item)` + `DocLightbox` 模态。`DocItem = { kind:'pdf'|'text', name, path, mimeType? }`。text：`fetch().text()` → md 走 `ChatMarkdown`，否则 `<pre>`；pdf：动态 `import()` pdf.js → `getDocument({data})` → 逐页 canvas，可滚动。头部含 ↓（原生感知 `downloadFile`）与 × 关闭、文件名 caption、Esc/scrim 关闭、body-scroll 锁 —— 与 `MediaViewer.Lightbox` 同构，复用其视觉 token。 |
| `web/src/features/media/pdf-worker.ts` | 集中设置 `GlobalWorkerOptions.workerPort`（`?worker` 导入），供 DocViewer 动态引入。 |

### 修改（web）

| 文件 | 变更 |
|---|---|
| `web/src/lib/files.ts` | `downloadFile()` 加 `isNativeShell()` 分流 → 原生壳走 `invoke('save_download')`（读字节→base64/Uint8Array→IPC），返回保存路径供 toast；浏览器路径不变。移除/停用仅服务媒体外"新开标签"的 `openFile`（不再需要——doc 内联、others 下载）；若被别处引用则一并清理。 |
| `web/src/features/workbench/MessageStream.tsx` | `AgentFileGroup` 三分类：media→lightbox（不变）、doc（`docKindOf`）→卡片主点击 `openDoc()`、other→仅下载。`AgentFileCard` 去掉会失效的 `OpenBtn`（`openFile`），doc 卡显示"预览"入口、others 只留 ↓ 下载 + ⧉ 复制路径。 |
| `web/src/mobile/v3/MChatView.tsx` | `AttachmentTile`：doc → 点击 `openDoc()`；other → 点击原生 `downloadFile`。 |
| `web/src/shell/AppShell.tsx` | 在 `MediaViewerProvider` 旁挂 `DocViewerProvider`。 |
| `web/src/mobile/MobileShell.tsx` | 同上挂 `DocViewerProvider`。 |
| `web/src/features/media/CORTEX.md` | 增补 DocViewer / doc-kind / 三分类说明。 |
| `web/src/features/workbench/CORTEX.md` | 更新"Image/video lightbox"备注 → 覆盖 doc 预览与 others 下载新行为；`openFile` 备注移除。 |
| `web/package.json` | 加 `pdfjs-dist` 依赖（固定次版本）。 |
| `web/vite.config.ts` | 如需（`?worker` 一般零配置；`optimizeDeps.exclude` pdf worker 视构建情况加）。 |

### 修改（desktop / Rust）

| 文件 | 变更 |
|---|---|
| `desktop/src-tauri/src/lib.rs` | 新增 `#[tauri::command] save_download(app, name, bytes) -> Result<String>`：桌面写 `download_dir()`、安卓写 `app_data_dir()/downloads/` 并发通知；文件名做 basename 清洗（防路径穿越）；注册进 `generate_handler!`。 |
| `desktop/CORTEX.md` | Tauri commands 表加 `save_download` 行；说明桌面/安卓落盘差异与安卓 app-private 限制。 |

（`capabilities/default.json` 不改——app 命令不需要 ACL 条目。）

## TDD / 测试

- `doc-kind.test.ts`：pdf/文本白名单、mimeType 分支、大小写、无扩展名、二进制→null、纯函数无副作用。
- 若把"原生 vs 浏览器下载"抽成纯判定（如 `resolveDownloadMode()`），加对应单测。
- DocViewer/DocLightbox 为呈现层，遵循现有约定（media 组件默认 no-op context，可无 provider 渲染），
  轻量渲染断言（text 分支 md vs pre；pdf 分支 loading/failed 态），pdf.js 在测试环境 mock。
- `pnpm --filter web test` 全绿；`pnpm --filter web build`（`tsc --noEmit && vite build`）通过。

## 端到端验证

1. `pnpm --filter web build`，确认 pdf.js worker 进 `web/dist` 且主包未显著膨胀（PDF 走动态导入）。
2. 桌面壳（`CORTEX_FRONTEND_DIR` 指向 `web/dist` 跑 `tauri dev`）：发一个 md、一个 pdf、一个 csv、
   一个 zip；验证 md/pdf/csv 内联预览、zip 触发原生保存并 toast 路径、下载目录确有文件。
3. 安卓：构建 release APK（`desktop/scripts/android-release.sh`）装机，重复上述；确认 pdf.js 在系统
   WebView 渲染、原生保存 + 通知可用。
4. 浏览器/ui-http 模式回归：`<a download>` 仍正常，预览一致。

## 风险与限制

- **pdf.js 体积**：worker ~1MB 级；用动态 `import()` 按需加载，避免拖累首屏与 OTA 包（记录实际增量）。
- **安卓下载落 app-private 目录**：非公共 Downloads，用户需经文件管理器取；作为已知限制记录，
  后续可用 Kotlin/DownloadManager 迭代到公共目录。
- **超大文件内联**：给 text 预览设上限（如 >2MB 截断并提示"文件过大，请下载查看"），PDF 逐页渲染
  天然分页，风险可控。
- **Rust 壳改动需重新构建 APK/桌面包**：OTA 只热更 SPA；`save_download` 是原生命令，需随壳发布一次。

## 不在本次范围

- 安卓公共 Downloads（MediaStore/DownloadManager）集成。
- 用系统默认程序"打开"文件（需 `tauri-plugin-opener`/`shell` 插件 + capability）——本次 others 只
  做"保存下载"，不做外部打开。
- Office（docx/xlsx/pptx）内联预览。

## 参考

- pdf.js + Vite worker 接线：mozilla/pdf.js Discussion #19520 / vite Discussion #16501。
