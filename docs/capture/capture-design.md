# Capture 模块设计

本文定义 `src/capture/` 的采集范围、统一数据结构和网络 adapter 行为。系统级依赖见 [architecture.md](../architecture.md)，文件位置见 [structure.md](../structure.md)。

## 目标

Capture 模块记录页面可观测的网络交互，不解释厂商业务协议。系统支持：

- 经 `fetch` 或 XHR 发起、底层协商为 HTTP/1.x、HTTP/2 或 HTTP/3 的请求与响应。
- 经 `fetch`、XHR 或原生 `EventSource` 建立的 SSE。
- 原生 `WebSocket` 的连接生命周期与双向应用消息。

“支持 HTTP/1/2/3”表示无论浏览器协商哪个版本都能采集上层报文语义。页面 API 通常不暴露准确协议版本、HTTP/2 frame 或 HTTP/3 stream，因此系统绝不猜测缺失信息。

## 模块边界

模块负责代理浏览器网络 API、复制可读数据、形成 Capture 和输出 CaptureFrame。它不加载配置、不编译 endpoint 规则、不持久化、不执行 delivery，也不解析 JSON、表单、Protobuf 或厂商字段。

## 文件

| 文件 | 设计职责 |
| :--- | :--- |
| `capture.ts` | 完整 Capture 联合类型、报文值对象和不变量 |
| `capture-frame.ts` | Base64 Body 分帧协议与运行时校验 |
| `capture-helpers.ts` | Capture ID、公共元数据、Headers 与 Body 安全读取 |
| `bytes.ts` | Uint8Array、Base64 与字节拼接转换 |
| `http-capture.ts` | 组合 fetch/XHR，管理 HTTP exchange |
| `fetch-adapter.ts` | 保持原生 fetch 语义并复制请求/响应流 |
| `xhr-adapter.ts` | 保持 XHR 生命周期并读取可观测报文 |
| `sse-framer.ts` | 对 fetch/XHR SSE 按原始字节边界分帧 |
| `event-source-adapter.ts` | 代理原生 EventSource，输出有损但明确标注的事件投影 |
| `websocket-capture.ts` | 代理原生 WebSocket，记录连接与双向消息 |

网络 adapter 是模块内部实现。入口只调用 `installCapture()`，不分别操作 fetch、XHR、EventSource 或 WebSocket。

## 统一数据结构

### 公共元数据

```ts
type Capture =
  | HttpRequestCapture
  | HttpResponseCapture
  | HttpErrorCapture
  | SseStreamOpenCapture
  | SseEventCapture
  | SseStreamCloseCapture
  | WebSocketOpenCapture
  | WebSocketMessageCapture
  | WebSocketCloseCapture
  | WebSocketErrorCapture;

interface CaptureBase {
  id: string;
  capturedAt: number;
  pageUrl: string;
  matchedRuleId: string;
  configRevision: string;
}

type HttpVersion = 'http/1.0' | 'http/1.1' | 'h2' | 'h3' | 'unknown';

interface HttpVersionObservation {
  value: HttpVersion;
  source: 'performance-resource-timing' | 'debugger' | 'unavailable';
}
```

`HttpVersionObservation` 只有在来源能够可靠关联当前 exchange 时才填写具体版本。当前 MAIN world 方案多数情况下记录 `unknown/unavailable`；未来接入 CDP 不需要改变 Capture 联合类型。

### Headers 与 Body

```ts
type MessageHeaders =
  | {
      state: 'captured';
      visibility: 'script-visible';
      entries: Array<[name: string, value: string]>;
    }
  | {
      state: 'unavailable';
      reason: 'api-restriction' | 'event-source-api' | 'websocket-api';
    };

type MessageBody =
  | { state: 'absent' }
  | {
      state: 'captured';
      encoding: 'base64';
      byteLength: number;
      data: string;
    }
  | {
      state: 'unavailable';
      reason:
        | 'opaque-response'
        | 'unsupported-body'
        | 'read-error'
        | 'size-limit'
        | 'storage-limit';
      partialByteLength?: number;
    };
```

Headers 使用二元组列表，避免对象结构丢失重复字段。Body 始终是 opaque bytes；Base64 只是跨 Chrome JSON 消息通道的传输表示。`absent`、零字节 `captured` 和 `unavailable` 不得合并。

Body 状态按可观测事实判定：

| 场景 | 状态 |
| :--- | :--- |
| 请求方法或响应状态按 HTTP 语义禁止 Body，例如 HEAD 响应、204、304 | `absent` |
| API 明确提供 Body，读取成功但长度为 0 | `captured`，`byteLength: 0` |
| 调用方未提供请求 Body，或 API 明确报告无 Body | `absent` |
| Body 可能存在，但因 opaque response、API 类型、读取错误或容量限制无法完整获得 | 对应原因的 `unavailable` |

`Content-Length: 0` 不能单独证明脚本可见 Body 不存在；实际读取成功时仍记录零字节 `captured`。任何只获得前缀的情况都记录 `unavailable` 和 `partialByteLength`，不得把前缀放入 `data`。

### HTTP 请求与响应

```ts
interface HttpCaptureBase extends CaptureBase {
  exchangeId: string;
  url: string;
  transport: 'fetch' | 'xhr';
  httpVersion: HttpVersionObservation;
}

interface HttpRequestCapture extends HttpCaptureBase {
  kind: 'http-request';
  method: string;
  headers: MessageHeaders;
  body: MessageBody;
}

interface HttpResponseCapture extends HttpCaptureBase {
  kind: 'http-response';
  status: number;
  statusText: string;
  headers: MessageHeaders;
  body: MessageBody;
}

interface HttpErrorCapture extends HttpCaptureBase {
  kind: 'http-error';
  phase: 'request' | 'response';
  reason: 'aborted' | 'network-error';
}
```

HTTP/1.x、HTTP/2 和 HTTP/3 使用同一结构，因为 method、URL、status、Headers 和 Body 的语义相同。底层 frame、header compression、chunked encoding 和 QUIC stream 不进入该模型。

请求发出后若浏览器没有产生响应，使用 `http-error` 结束 exchange。采集器自身的异常属于诊断，不得伪装成页面网络错误。

### SSE 生命周期

```ts
type SseSource = 'fetch' | 'xhr' | 'event-source';
type SseFidelity = 'raw-event-bytes' | 'decoded-text-projection' | 'message-event-projection';
type Observation<T, R extends string> =
  | { state: 'observed'; value: T }
  | { state: 'unavailable'; reason: R };

interface SseCaptureBase extends CaptureBase {
  streamId: string;
  exchangeId: string | null;
  url: string;
  source: SseSource;
  fidelity: SseFidelity;
  attempt: number;
}

interface SseStreamOpenCapture extends SseCaptureBase {
  kind: 'sse-stream-open';
  status: Observation<number, 'event-source-api'>;
  statusText: Observation<string, 'event-source-api'>;
  headers: MessageHeaders;
  httpVersion: HttpVersionObservation;
}

interface SseEventCapture extends SseCaptureBase {
  kind: 'sse-event';
  sequence: number;
  eventType: string | null;
  lastEventId: string | null;
  body: Extract<MessageBody, { state: 'captured' }>;
}

interface SseStreamCloseCapture extends SseCaptureBase {
  kind: 'sse-stream-close';
  outcome: 'eof' | 'aborted' | 'reconnecting' | 'read-error' | 'limit-exceeded';
  eventCount: number;
  capturedByteLength: number;
  truncatedDueToLimit: boolean;
  partialEventByteLength?: number;
  reason?: string;
}
```

Fetch 与二进制 XHR SSE 使用 `raw-event-bytes`，通过 `exchangeId` 关联其 `http-request`，Body 包含完整 event 字段行和分隔符。文本型 XHR 使用 `decoded-text-projection`：浏览器先将响应解码为 `responseText`，扩展再编码为 UTF-8 后分帧，因此不声称保留原始编码字节。原生 EventSource 使用 `message-event-projection`，其 `exchangeId` 为 `null`：只能把 `MessageEvent.data` 编码为 UTF-8 bytes，并记录浏览器提供的 event type 与 lastEventId；实际请求、status、Headers、注释、`retry` 行、原始换行及自动重连请求不可观测，必须显示为 unavailable，不能伪装成完整原文。

Fetch/XHR 的 `attempt` 固定为 1。每个 EventSource 实例拥有一个稳定 `streamId`：首次 `open` 为 attempt 1，此后同一实例每次再次触发 `open` 表示浏览器完成一次自动重连并递增 attempt。用户新建 EventSource 会获得新 `streamId` 并从 1 开始。`error` 在 `readyState === CONNECTING` 时产生当前 attempt 的 `reconnecting` close；显式 `close()` 产生 `aborted` close。浏览器没有提供“永久停止重连”的可靠事件，因此除显式关闭外，不声称观察到最终关闭。

`eventCount` 只统计已完整保存的 event。单个 event 或 stream 超限时，close 使用 `limit-exceeded`、`truncatedDueToLimit: true`；若已读取超限 event 的部分数据，写入 `partialEventByteLength`。正常终态该字段为 false。

### WebSocket 生命周期

```ts
interface WebSocketCaptureBase extends CaptureBase {
  connectionId: string;
  url: string;
}

interface WebSocketOpenCapture extends WebSocketCaptureBase {
  kind: 'websocket-open';
  requestedProtocols: string[];
  negotiatedProtocol: string;
  extensions: string;
  handshake: { state: 'unavailable'; reason: 'websocket-api' };
}

interface WebSocketMessageCapture extends WebSocketCaptureBase {
  kind: 'websocket-message';
  direction: 'outbound' | 'inbound';
  sequence: number;
  payloadType: 'text' | 'binary';
  body: Extract<MessageBody, { state: 'captured' | 'unavailable' }>;
}

interface WebSocketCloseCapture extends WebSocketCaptureBase {
  kind: 'websocket-close';
  code: number;
  reason: string;
  wasClean: boolean;
  sentMessageCount: number;
  receivedMessageCount: number;
}

interface WebSocketErrorCapture extends WebSocketCaptureBase {
  kind: 'websocket-error';
  phase: 'connecting' | 'open';
  reason: 'unspecified-by-browser';
}
```

浏览器 WebSocket API 能提供应用消息，但不能提供握手响应状态/Headers、ping/pong、wire frame 边界、masking 或压缩前字节。文本消息按 UTF-8 编码后保存；`ArrayBuffer`、TypedArray 和 Blob 保存其二进制 bytes。每个方向独立从 1 递增 sequence，未成功保存的超限消息仍占用一个 sequence。

构造器同步抛错时，在保持原异常类型和时机的前提下产生 `websocket-error`，`phase: connecting`，且不产生 open/close。构造成功但在 open 前触发 `error` 时也产生 connecting error；若随后可观察到 close，仍保存 close。API 不提供失败状态码或响应 Headers，握手失败原因只能是 `unspecified-by-browser`。

## 公开接口

```ts
interface CaptureMatcher {
  match(url: string, protocol: 'http' | 'websocket'): EndpointMatch;
}

interface CaptureSink {
  emit(frame: CaptureFrame): void;
}

function installCapture(options: {
  match: CaptureMatcher['match'];
  emit: CaptureSink['emit'];
  policy(): CapturePolicy;
}): () => void;
```

`CapturePolicy` 由 Capture 模块拥有，只包含协议开关和采集限制。Config 生成的 `MainCaptureConfig` 以结构类型满足它；Capture 不导入 Config 模块。

## CaptureFrame 生命周期

```ts
type CaptureFrame =
  | CaptureStartFrame
  | CaptureChunkFrame
  | CaptureBodyUnavailableFrame
  | CaptureEndFrame
  | CaptureErrorFrame;

interface CaptureFrameBase {
  protocolVersion: 1;
  captureId: string;
  frameSequence: number;
  configRevision: string;
}

type BodyCaptureDescriptor =
  | Omit<HttpRequestCapture, 'body'>
  | Omit<HttpResponseCapture, 'body'>
  | Omit<SseEventCapture, 'body'>
  | Omit<WebSocketMessageCapture, 'body'>;

type BodylessCapture = Exclude<
  Capture,
  | HttpRequestCapture
  | HttpResponseCapture
  | SseEventCapture
  | WebSocketMessageCapture
>;

type CaptureStartDescriptor =
  | {
      body: 'framed';
      capture: BodyCaptureDescriptor;
    }
  | {
      body: 'not-applicable';
      capture: BodylessCapture;
    };

type CaptureCompletion =
  | { body: 'not-applicable' }
  | { body: Extract<MessageBody, { state: 'absent' }> }
  | {
      body: Omit<Extract<MessageBody, { state: 'captured' }>, 'data'>;
    }
  | { body: Extract<MessageBody, { state: 'unavailable' }> };

interface CaptureStartFrame extends CaptureFrameBase {
  type: 'start';
  frameSequence: 0;
  descriptor: CaptureStartDescriptor;
}

interface CaptureChunkFrame extends CaptureFrameBase {
  type: 'chunk';
  bodyField: 'body';
  chunkSequence: number;
  encoding: 'base64';
  byteLength: number;
  data: string;
}

interface CaptureBodyUnavailableFrame extends CaptureFrameBase {
  type: 'body-unavailable';
  bodyField: 'body';
  reason: Extract<MessageBody, { state: 'unavailable' }>['reason'];
  partialByteLength?: number;
}

interface CaptureEndFrame extends CaptureFrameBase {
  type: 'end';
  completion: CaptureCompletion;
}

interface CaptureErrorFrame extends CaptureFrameBase {
  type: 'error';
  reason: 'capture-cancelled' | 'invalid-state' | 'channel-overflow';
}
```

`CaptureStartDescriptor` 携带完整的非 Body Capture 数据。`body: framed` 只允许四种含 Body 的 Capture，`body: not-applicable` 只允许其余六种终态记录。`CaptureCompletion` 声明重建结果：captured 只携带总长度，实际 data 必须由全部 chunk 拼接；unavailable 必须与此前 `body-unavailable` 一致。Storage 以 `captureId`、`frameSequence` 作为重放幂等键，并校验同一序号的内容完全相同。

- 一般记录：`start → chunk* → end`。
- Body 读取失败或超过上限：`start → chunk* → body-unavailable → end`。
- 协议无效或记录不应存在：`start → ... → error`。
- `body-unavailable` 使 Storage 删除此前 chunks、保留报文 descriptor，并以 unavailable Body 完成记录。
- `frameSequence` 从 0 严格连续递增；`chunkSequence` 仅对 Body chunk 从 0 连续递增。
- 每个 chunk 解码后最多 64 KiB，并携带 Base64 数据与 `byteLength`；控制帧受独立 envelope 大小上限约束。

## 采集流程

### Fetch 与 XHR

1. 在调用原生 API 前匹配 URL 并固定规则及配置 revision。
2. 记录请求报文；不可观测字段使用 unavailable，不伪造空值。
3. 尽早调用原生 API，采集异常不能延迟或改变页面调用。
4. Fetch 在响应交给页面前立即调用 `response.clone()`；原 Response 原样返回，采集器只异步读取 clone，且不等待采集完成。clone 失败或读取分支落后导致容量超限时放弃采集副本，不取消或消费页面分支。
5. SSE 响应产生 open、零到多个 event 和 close，并关联发起它的 HTTP request。
6. 请求失败且没有响应时产生 `http-error`，让 exchange 具有明确终态。

Fetch 请求 Body 仅从可安全 clone 的 `Request` 副本读取；clone 必须在原始 `fetch` 消费 Request 之前创建，但原 Request 和 init 仍原样传给页面请求。无法安全复制的 `ReadableStream` 请求或 clone 失败记录 `unsupported-body`，原参数不被替换。XHR 只在原生 `loadend` 生命周期之后读取已缓冲的 `response`，不包装 Response、不再次发起请求，也不延迟页面事件：

| XHR `responseType` | 采集规则 |
| :--- | :--- |
| `''`、`text` | 以 UTF-8 保存浏览器解码后的字符串，并明确标记 `decoded-text-projection`；不得将其视为响应 Body 原始 bytes |
| `arraybuffer` | 直接复制 ArrayBuffer bytes |
| `blob` | 异步调用 `arrayBuffer()`；页面事件不等待采集 |
| `json`、`document` | `unavailable: unsupported-body`，不得重新序列化 |

Fetch/XHR 请求端仅记录可无副作用读取的 string、URLSearchParams、ArrayBuffer、TypedArray 和 Blob；URLSearchParams 使用标准 `application/x-www-form-urlencoded` 序列化结果。Document、FormData、流式或未知对象记录 `unsupported-body`，不得为了采集改变浏览器序列化。

### EventSource

1. 包装构造器但不建立第二条网络连接。
2. 记录 URL、构造参数和 API 可见生命周期。
3. 将 MessageEvent 投影为明确标注 fidelity 的 SSE event。
4. 不声称获得请求 Headers、响应 Headers 或原始 event bytes。

### WebSocket

1. 包装构造器并保留原型、静态常量和异常行为。
2. 包装实例 `send()` 记录 outbound payload，不改变发送参数。
3. 监听 `open/message/error/close` 记录 inbound 消息和生命周期。
4. 不记录浏览器未暴露的握手和控制帧细节。

## 容量策略

以下是构建内不可突破的默认硬上限；运行时 SystemConfig 只能调低：

| 限制 | 默认值 | 超限行为 |
| :--- | ---: | :--- |
| 单个 Frame 解码后数据 | 64 KiB | 拒绝 Frame，终止对应 Capture |
| 普通 HTTP Body | 16 MiB | 删除 chunks，以 `unavailable: size-limit` 完成报文元数据 |
| 单个 SSE event | 1 MiB | 丢弃该 event，关闭采集并记录 `limit-exceeded` |
| 单个 SSE stream 累计 bytes | 64 MiB | 停止后续采集并记录 `limit-exceeded` |
| 单个 WebSocket message | 4 MiB | 保存 unavailable message 元数据，连接继续采集 |
| 单个 WebSocket connection 累计 bytes | 64 MiB | 停止该连接后续采集并保留 close/诊断元数据 |

超限只停止扩展副本的读取或记录，不取消页面请求、SSE 流或 WebSocket。普通 Body 不保留前缀，避免被误认为完整数据。

## 不变量

- 每条 Capture 有唯一 `id`；HTTP 使用 `exchangeId`，SSE 使用 `streamId`，WebSocket 使用 `connectionId` 关联生命周期。
- 所有不可观测字段显式标记 unavailable，不以空字符串、空数组或默认版本冒充。
- `Content-Type` 只参与 SSE 识别和 UI 预览，不触发业务解析。
- Fetch/XHR 响应复制、EventSource 监听和 WebSocket 监听都不能改变页面行为。
- 每个安装动作可幂等卸载并恢复原生构造器或方法。

## 测试

- HTTP：HTTP/1/2/3 版本值与 unknown、请求/响应粒度、opaque Body、页面语义和卸载恢复。
- SSE framing：LF、CRLF、跨 chunk、空 event、不完整尾部和容量超限。
- EventSource：open/message/error/reconnect、投影 fidelity 与不可观测字段。
- WebSocket：构造器语义、文本/二进制双向消息、sequence、close/error 和容量超限。
- Frame：Base64/byteLength、状态转换、重复、乱序及 `body-unavailable`。

浏览器集成测试必须覆盖真实 fetch streaming、XHR responseType、EventSource 和 WebSocket echo server；单元测试不足以证明代理透明性。