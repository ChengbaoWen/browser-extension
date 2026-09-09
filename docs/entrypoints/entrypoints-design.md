# Entry Points 模块设计

本文描述 `src/entrypoints/` 的运行时组装与 Side Panel 边界。系统级约束见 [architecture.md](../architecture.md)，文件位置见 [structure.md](../structure.md)。

## 目标

Entry Points 把能力模块连接到 Chrome MV3 的 MAIN、ISOLATED、Background 和 Side Panel 运行上下文。入口只选择实现、注入依赖和绑定生命周期，不承载业务规则。

## 文件与上下文

| 路径 | 上下文 | 设计职责 |
| :--- | :--- | :--- |
| `injected.content.ts` | MAIN world | 维护当前 matcher，安装 HTTP/SSE/EventSource/WebSocket Capture 与配置接收端 |
| `content.ts` | ISOLATED world | 安装 CaptureFrame 上行桥和配置下行桥 |
| `background.ts` | Service Worker | 创建 Config Manager、Capture Store、Delivery 并绑定 Port 与调度事件 |
| `sidepanel/` | Extension page | 开发与生产构建均包含的完整只读检查 UI |

## MAIN 组装

1. 创建初始空 matcher，保证配置到达前不采集。
2. 创建 Main Capture sender。
3. 安装配置接收端；每个有效快照创建新 Endpoint Matcher 并原子替换当前函数。
4. 将稳定的 `match(url, protocol)`、`send(frame)` 和 `MainCaptureConfig` 注入统一 Capture 模块。
5. 在入口失效时按逆序卸载监听器和代理。

入口不解析 HTTP、SSE 或规则，也不直接发送 Chrome runtime 消息。

## ISOLATED 组装

`content.ts` 只安装 Channel 能力。它不导入 Endpoint Matcher、Storage 或 Delivery，也不读取页面正文。所有来自 MAIN 的数据都以 `unknown` 进入校验器。

## Background 组装

1. 创建 `BundledConfigSource`、SafetyPolicy、LocalConsent source 与 Config Manager。
2. 创建 Capture Store，并以 `CaptureWriter` 注入 Port 消费端。
3. 把 MAIN/ISOLATED 最小配置投影发布到所有活动 Content Script；完整 SystemConfig 不离开 Background。
4. 仅在本地授权与配置同时允许时创建 Delivery 调度。
5. 配置点击扩展图标时打开 Side Panel。
6. 将浏览器启动、alarm 和 Port 生命周期映射为模块调用。

未来切换 HTTP 配置只替换第一步的 ConfigSource。入口不得把来源分支或完整 SystemConfig 传播到其他模块。

## Side Panel

`sidepanel/` 共置 HTML、React、样式和组件。该目录可以整体删除，不需要修改 Background、Channel 或核心模块。

- UI 直接使用 `CaptureReader & CaptureCleaner`，不建立 UI 专用 Background 消息协议。
- UI 通过 Config 模块的只读 `ConfigProjectionStore` 获取 `DebugUiConfig`，不读取完整 SystemConfig。
- UI 除经确认的全量清理外不修改 Capture，不修改配置、不触发 delivery。
- UI 通过刷新或短周期查询显示完成报文；当前交互的记录数增长时同步刷新详情条，不订阅 Body 广播。
- React 与 Tailwind 只能由该目录导入，核心入口不依赖前端包。

### Debug UI 信息架构

Side Panel 使用紧凑的报文检查器布局，而不是对话界面：

- 左栏按交互类型分组：HTTP 使用 `exchangeId`，SSE 使用 `streamId`，WebSocket 使用 `connectionId`。
- HTTP 组完整列出 request 与 response；SSE 组列出 stream open、event 和 close；WebSocket 组列出 open、双向 message、error 和 close。
- SSE 组明确显示 `STREAM OPEN`、各 `EVENT #n` 和 `STREAM CLOSE`，close 展示 EOF、abort、读取错误或容量超限。
- 右栏提供 `Overview`、`Headers` 和 `Body` 三个视图，展示 URL、页面来源、transport、规则 ID、配置 revision 和时间。
- Headers 按二元组逐行展示，不转成会丢失重复字段的对象。
- Body 显示 `absent`、`unavailable` 或实际 byteLength；已捕获 Body 可切换 Hex、Base64 和 Text 视图。
- EventSource 投影和 WebSocket 握手等有损记录必须显示 fidelity/unavailable 警告，不能伪装为完整报文。
- Text 优先按 Header 声明的 charset 解码，未声明时使用 UTF-8；不格式化 JSON、不提取字段、不推断厂商协议，解码失败时回退 Hex。
- UI 可复制 Headers、Base64 或派生文本；顶部清理按钮经确认后清空全部 Capture、诊断与当前展示状态。
- 顶部容量状态显示当前逻辑占用、提醒/硬水位，以及 Channel 或 Storage 最近一次溢出诊断。

### Capture 渲染规则

UI 直接以 Capture 的判别字段 `kind` 渲染，不建立 Provider、Prompt、Model 或 Session ViewModel：

| Capture kind | 列表摘要 | 详情 |
| :--- | :--- | :--- |
| `http-request` | method、host/path、时间、Body 大小 | URL、HTTP 版本观测、Headers、完整 Body、规则与配置 revision |
| `http-response` | status、host/path、时间、Body 大小 | status/statusText、HTTP 版本观测、Headers、完整 Body |
| `http-error` | phase、错误类别 | exchange 元数据和明确的无响应原因 |
| `sse-stream-open` | source、attempt、status | fidelity、响应头、协议版本和不可观测字段 |
| `sse-event` | sequence、event type、Body 大小 | lastEventId、完整原始 event bytes 或 MessageEvent 投影 |
| `sse-stream-close` | outcome、event count | 结束原因、累计字节和 attempt |
| `websocket-open` | URL、subprotocol | requested/negotiated protocol、extensions、握手 unavailable 状态 |
| `websocket-message` | direction、sequence、payload type、大小 | 完整 text/binary payload bytes |
| `websocket-error` | error | 浏览器可提供的有限错误信息 |
| `websocket-close` | code、clean 状态 | reason、收发消息计数和连接元数据 |

HTTP exchange 详情以 Request、Response/Error 两段展示，不把两条 Capture 合并写回数据库。Fetch/XHR SSE 在顶部展示关联请求，随后按时间线显示 stream open、events 和 close；EventSource 请求区域明确显示“浏览器 API 不可观测”。WebSocket 使用双向时间线，以方向图标区分 sent/received。

列表仅加载 `InteractionSummary` 和 `CaptureSummary`；用户选中记录后才调用 `getById` 加载完整 Headers 与 Body，避免大量 Base64 数据拖慢 Side Panel。

## 构建

- 开发和生产构建都包含 `background`、`content`、`injected` 和 `sidepanel` 四类入口。
- `wxt.config.ts` 始终声明 `sidePanel` 权限，Manifest 的 `side_panel` 由 WXT 入口生成。
- Background 调用 `setPanelBehavior({ openPanelOnActionClick: true })`，扩展图标不承担采集开关功能。
- 生产构建测试必须解包产物并断言：存在 `side_panel` manifest key、Side Panel 资源及 React 挂载代码。

## 不变量

- 入口文件不定义领域类型、Frame 状态机、匹配算法、数据库事务或 DTO mapper。
- 三个核心入口禁止导入 `entrypoints/sidepanel/`。
- Side Panel 只能单向依赖 Capture 类型、Storage 的只读接口和 Config 的只读 DebugUiConfig store。
- 每个安装动作都返回或登记对应清理动作。
- 重复启动事件不能创建重复代理、Port listener 或 delivery timer。

## 失败策略

- MAIN 安装失败只禁用采集，不影响页面网络 API。
- ISOLATED Port 失败交给 Channel 的有界重连处理。
- Background 配置失败使用空白名单；Storage 失败停止摄入并记录诊断。
- Delivery 初始化或 flush 失败不阻止配置和本地采集。
- Side Panel 查询失败显示开发诊断，不向 Background 请求特权操作。

## 测试

- 每个入口的依赖组装使用 fake 模块验证，不重复测试模块内部算法。
- MAIN 配置替换后新请求使用新 matcher，进行中请求保持旧 revision。
- HTTP/SSE/WebSocket 三种交互分组及详情按 Capture 联合类型穷尽渲染。
- Background 重启不会重复注册调度或破坏草稿恢复。
- 生产构建包含可加载的 Side Panel，并由扩展图标打开。
- `production-build.test.ts` 检查 Manifest、产物文件和核心 bundle 的 UI 依赖。