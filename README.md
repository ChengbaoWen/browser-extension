# Chrome 网页 AI 数据采集扩展

一个面向 Chrome MV3 的浏览器扩展，目标是在用户正常使用网页 AI 服务时，按 SystemConfig 中的 endpoint 规则采集页面可观测的 HTTP/1.x、HTTP/2、HTTP/3、SSE 和 WebSocket 数据。

当前仓库已建立 v1 Capture 架构。系统边界和模块职责见 [架构文档](docs/architecture.md)，已验证范围与剩余验收见 [结构文档](docs/structure.md#实现一致性状态)。

## 项目目标

- 在不改变页面请求和响应行为的前提下捕获网络数据。
- Config 管理所有模块的版本化系统配置；当前由 `BundledConfigSource` 读取 `system-config.json`，后续通过同一接口切换为服务端配置。
- 从 HTTP 报文层面保存 method、URL、status、Headers 和 opaque Body bytes，不解析厂商 JSON。
- 使用 IndexedDB 在本机可靠持久化数据，不依赖 Service Worker 内存保存状态。
- 统一支持 HTTP/1.x、HTTP/2、HTTP/3、SSE 和 WebSocket 应用层数据。

## 技术栈

| 类别 | 选型 | 用途 |
| :--- | :--- | :--- |
| 浏览器平台 | Chrome Manifest V3 | 扩展运行环境 |
| 扩展框架 | WXT | 入口、Manifest 与构建管理 |
| 开发语言 | TypeScript 严格模式 | 类型安全的扩展逻辑 |
| 网络 API | Fetch、XMLHttpRequest、Web Streams | 请求捕获与响应流复制 |
| 配置 | SystemConfig、ConfigSource | 所有模块配置、当前 bundled snapshot 及未来 HTTP 来源 |
| 持久化 | IndexedDB | 本地原文存储及 delivery pending 队列 |
| 测试 | Vitest | URL 匹配、SSE 分帧与采集粒度测试 |
| 检查界面 | React、Side Panel | 开发与生产构建查看采集结果 |

## 采集范围

### HTTP 与 HTTPS

扩展在页面 MAIN world 中代理 `fetch` 和 XMLHttpRequest。只有 URL 命中当前有效配置的规则时才进入采集流程。HTTP/1.x、HTTP/2 和 HTTP/3 在该层共享同一报文结构；协议版本只有在浏览器提供可靠证据时记录，否则明确为 unknown。

一次普通 HTTP/HTTPS 往返最多产生两条独立记录：

1. 请求报文：method、URL、页面 JavaScript 可见的 Headers 和 opaque Body bytes。
2. 响应报文：status、可见 Headers 和未经语义解析的 opaque Body bytes。

Body 不以 JSON、文本或表单对象入库，而是统一保存为带字节长度的 Base64。`Content-Type` 只用于识别 SSE 和提供 UI 显示提示，不改变存储结构。无 Body、零字节 Body 和受浏览器 API 限制而不可读取的 Body 会被明确区分。

该方案采集的是 fetch/XHR 暴露的报文语义，不是网络抓包：HTTP 版本、线上 Header 原始大小写和顺序、浏览器隐藏 Header、压缩前 Body 及 HTTP/2 frame 等信息不可保证获得。

### SSE

Fetch/XHR 根据响应头中的 `Content-Type: text/event-stream` 判断 SSE，并保存原始 event bytes。原生 `EventSource` 也受支持，但只能保存 MessageEvent 投影；其响应头和原始 event 字节明确标记 unavailable，不伪装成完整原文。

- 响应建立时保存一条 `sse-stream-open`，包含 status 和 Headers。
- 每个完整 SSE event 单独保存一条原文记录。
- 流结束时保存一条 `sse-stream-close`，记录 EOF、中断、读取错误或容量超限。
- 网络数据块不等于 SSE event；跨数据块的 event 会先正确分帧。
- 不将多个 event 拼接为一条回复。
- 未完整读取到的 event 不落盘。

因此，一次 SSE 请求会形成 `1 条请求 + 1 条 stream-open + N 条 SSE event + 1 条 stream-close`。

### WebSocket

扩展代理原生 WebSocket，保存 open、双向 text/binary message、error 和 close，并通过 `connectionId` 关联。浏览器不暴露的握手响应、ping/pong、wire frame 和压缩前字节明确标记 unavailable。

## 存储与隐私

采集内容是浏览器解密后的明文，可能包含 Authorization、请求体及其他敏感信息。浏览器自动附加的 `Cookie` 等受限请求头不保证可见。数据默认只写入本机 IndexedDB，不做截断或脱敏，请仅在可信设备和授权页面中使用。

扩展安装后会按 SystemConfig 自动开启采集，不提供用户开关；SystemConfig 仍可通过 `capture.enabled` 统一停用采集。delivery 使用独立的本地授权且默认关闭，远端配置不能绕过本地授权开启外发。IndexedDB 维护批次 HTTP delivery 的 pending 状态，但当前 bundled 配置关闭外发。当前配置不会产生配置服务请求；未来访问配置服务时，请求也不包含本机 Capture 数据。启用 delivery 后，也必须在服务端确认成功后才能确认对应记录。

为避免异常页面、无限 SSE 或大文件耗尽扩展资源，v1 对 Frame、普通 Body、SSE event、单流累计数据、断线队列和 IndexedDB 设置分层硬限制。超限时停止对应采集并记录诊断，但不取消或截断页面自己的网络流；已完成记录不会被静默循环覆盖。

## 调试界面

扩展提供 Side Panel，从 Capture 联合类型展示完整可观测数据：HTTP request/response、SSE stream/event、WebSocket connection/message。点击 Chrome 工具栏中的扩展图标即可打开抓取列表；顶部清理按钮经确认后删除全部本地 Capture 和诊断记录，但不会关闭后续采集。详情包含协议观测、Headers、Body bytes、fidelity、匹配规则和配置版本；Body 支持 Hex、Base64 和 Text 视图。Text 优先使用声明的 charset，未声明时按 UTF-8 解码，失败则回退 Hex；界面不格式化 JSON 或提取厂商字段。

Capture 保存在客户端 IndexedDB，并通过只读 Side Panel 提供查看入口；拥有浏览器 DevTools 或本机文件访问权限的人也可能直接读取数据，因此不能对设备所有者隐藏本地明文。

## 开发命令

```bash
npm run dev
npm run test
npm run compile
npm run build
npm run clean
```

- `npm run dev`：启动 WXT 开发模式并加载扩展。
- `npm run test`：运行 Vitest 测试。
- `npm run compile`：准备 WXT 生成类型并执行 TypeScript 类型检查，可在 `clean` 后直接运行。
- `npm run build`：生成 Chrome MV3 生产构建，输出到 `.output/chrome-mv3`。
- `npm run clean`：删除 WXT 的 `.output/` 构建产物和 `.wxt/` 缓存，不删除源码或依赖。
