# Delivery 模块设计

本文描述 `src/delivery/` 的外部 JSON 契约与推送编排。系统级约束见 [architecture.md](../architecture.md)，文件位置见 [structure.md](../structure.md)。

## 目标

Delivery 模块在本地授权和有效配置同时允许时，把 pending Capture 映射成版本化批次并通过 HTTP 发送。默认状态是关闭且不产生任何网络活动。

## 边界

模块负责队列消费、DTO 映射、批次元数据、单飞控制、HTTP 传输和成功确认。模块不拥有 Capture 存储、配置生命周期、采集逻辑或 UI。

## 文件

| 文件 | 设计职责 |
| :--- | :--- |
| `delivery.ts` | 定义使用者接口并编排读取、发送与确认 |
| `delivery-contract.ts` | `DeliveryBatch`、`DeliveryCapture` 和显式映射 |
| `client-context.ts` | 读取扩展版本与允许上报的浏览器环境信息 |
| `http-delivery.ts` | HTTPS 请求、禁止重定向和响应判定；v1 不实现鉴权注入 |

## 公开接口

```ts
interface DeliveryQueue {
  listPending(limit: number): Promise<Capture[]>;
  markDelivered(captureIds: string[]): Promise<void>;
}

interface DeliveryTransport {
  send(batch: DeliveryBatch, signal: AbortSignal): Promise<DeliveryReceipt>;
}

interface Delivery {
  flush(): Promise<DeliveryResult>;
}

function createDelivery(options: DeliveryOptions): Delivery;
function toDeliveryCapture(capture: Capture): DeliveryCapture;
```

这些接口由 Delivery 拥有。Capture Store 和 HTTP adapter 以结构类型满足它们，Delivery 不导入 Storage 或全局 fetch 实例。

## 启用条件

Delivery 仅在以下条件全部满足时运行：

- 本地用户授权明确开启。
- 当前 `DeliveryConfig` 投影允许 delivery，且 endpoint 有效。
- endpoint 使用 HTTPS 且 origin 在构建时允许列表中。
- Background 生命周期事件或受控定时器触发 `flush()`。

任一条件不满足时，不创建定时器、不读取队列、不构造批次、不发送请求。

## Flush 流程

1. 通过单飞锁合并并发 `flush()` 调用。
2. 再次检查启用条件并读取当前 batchSize。
3. 从 `DeliveryQueue` 读取确定顺序的 pending Capture。
4. 显式映射为 `DeliveryCapture`，补充 batchId、createdAt 和 client context。
5. Transport 在超时信号下发送一个版本化 JSON 批次。
6. 只有服务端返回明确成功 receipt 后才确认该批 ID。
7. 返回发送、跳过或失败结果，供 Background 调度下一次尝试。

## 契约与兼容

v1 的外部 JSON 契约如下。这里的类型在 `delivery-contract.ts` 独立声明；即使字段形状相同，也不能直接把 IndexedDB 对象序列化后发送。

```ts
interface DeliveryBatch {
  schemaVersion: 1;
  batchId: string;
  createdAt: number;
  client: {
    extensionVersion: string;
    browser: 'chrome';
  };
  captures: DeliveryCapture[];
}

interface DeliveryCaptureBase {
  id: string;
  capturedAt: number;
  pageUrl: string;
  matchedRuleId: string;
  configRevision: string;
}

type DeliveryHeaders =
  | { state: 'captured'; visibility: 'script-visible'; entries: Array<[string, string]> }
  | { state: 'unavailable'; reason: 'api-restriction' | 'event-source-api' | 'websocket-api' };

type DeliveryBody =
  | { state: 'absent' }
  | { state: 'captured'; encoding: 'base64'; byteLength: number; data: string }
  | {
      state: 'unavailable';
      reason: 'opaque-response' | 'unsupported-body' | 'read-error' | 'size-limit' | 'storage-limit';
      partialByteLength?: number;
    };

type DeliveryHttpVersion = {
  value: 'http/1.0' | 'http/1.1' | 'h2' | 'h3' | 'unknown';
  source: 'performance-resource-timing' | 'debugger' | 'unavailable';
};

interface DeliveryHttpBase extends DeliveryCaptureBase {
  exchangeId: string;
  url: string;
  transport: 'fetch' | 'xhr';
  httpVersion: DeliveryHttpVersion;
}

interface DeliverySseBase extends DeliveryCaptureBase {
  streamId: string;
  exchangeId: string | null;
  url: string;
  source: 'fetch' | 'xhr' | 'event-source';
  fidelity: 'raw-event-bytes' | 'decoded-text-projection' | 'message-event-projection';
  attempt: number;
}

interface DeliveryWebSocketBase extends DeliveryCaptureBase {
  connectionId: string;
  url: string;
}

type DeliveryCapture =
  | (DeliveryHttpBase & {
      kind: 'http-request';
      method: string;
      headers: DeliveryHeaders;
      body: DeliveryBody;
    })
  | (DeliveryHttpBase & {
      kind: 'http-response';
      status: number;
      statusText: string;
      headers: DeliveryHeaders;
      body: DeliveryBody;
    })
  | (DeliveryHttpBase & {
      kind: 'http-error';
      phase: 'request' | 'response';
      reason: 'aborted' | 'network-error';
    })
  | (DeliverySseBase & {
      kind: 'sse-stream-open';
      status: { state: 'observed'; value: number } | { state: 'unavailable'; reason: 'event-source-api' };
      statusText: { state: 'observed'; value: string } | { state: 'unavailable'; reason: 'event-source-api' };
      headers: DeliveryHeaders;
      httpVersion: DeliveryHttpVersion;
    })
  | (DeliverySseBase & {
      kind: 'sse-event';
      sequence: number;
      eventType: string | null;
      lastEventId: string | null;
      body: Extract<DeliveryBody, { state: 'captured' }>;
    })
  | (DeliverySseBase & {
      kind: 'sse-stream-close';
      outcome: 'eof' | 'aborted' | 'reconnecting' | 'read-error' | 'limit-exceeded';
      eventCount: number;
      capturedByteLength: number;
      truncatedDueToLimit: boolean;
      partialEventByteLength?: number;
      reason?: string;
    })
  | (DeliveryWebSocketBase & {
      kind: 'websocket-open';
      requestedProtocols: string[];
      negotiatedProtocol: string;
      extensions: string;
      handshake: { state: 'unavailable'; reason: 'websocket-api' };
    })
  | (DeliveryWebSocketBase & {
      kind: 'websocket-message';
      direction: 'outbound' | 'inbound';
      sequence: number;
      payloadType: 'text' | 'binary';
      body: Extract<DeliveryBody, { state: 'captured' | 'unavailable' }>;
    })
  | (DeliveryWebSocketBase & {
      kind: 'websocket-close';
      code: number;
      reason: string;
      wasClean: boolean;
      sentMessageCount: number;
      receivedMessageCount: number;
    })
  | (DeliveryWebSocketBase & {
      kind: 'websocket-error';
      phase: 'connecting' | 'open';
      reason: 'unspecified-by-browser';
    });

interface DeliveryReceipt {
  schemaVersion: 1;
  batchId: string;
  acceptedCaptureIds: string[];
}
```

映射规则固定如下：

| Capture kind | Delivery kind | 必须保留的专有语义 |
| :--- | :--- | :--- |
| `http-request` | `http-request` | method、Headers、Body、exchange、transport、HTTP version observation |
| `http-response` | `http-response` | status/statusText、Headers、Body 和完整 HTTP 关联字段 |
| `http-error` | `http-error` | phase、reason 和完整 HTTP 关联字段 |
| `sse-stream-open` | `sse-stream-open` | source、fidelity、attempt、结构化 unavailable status/Headers |
| `sse-event` | `sse-event` | sequence、eventType、lastEventId 和 event bytes |
| `sse-stream-close` | `sse-stream-close` | outcome、已保存计数/字节及截断信息 |
| `websocket-open` | `websocket-open` | 请求/协商协议、extensions 和握手不可观测状态 |
| `websocket-message` | `websocket-message` | direction、sequence、payloadType 和 Body 状态 |
| `websocket-close` | `websocket-close` | code、reason、wasClean 和双向消息计数 |
| `websocket-error` | `websocket-error` | connecting/open phase 和浏览器可见原因 |

mapper 使用 `switch (capture.kind)` 并在 default 分支调用 `assertNever(capture)`；字段逐一复制，不解析 Body、不把 `null` 或 unavailable 改写为空值。receipt 只有在 `batchId` 完全匹配且 `acceptedCaptureIds` 与本批 Capture ID 集合完全相等时才算成功，部分接受视为整批失败且不调用 `markDelivered`。

- `DeliveryBatch.schemaVersion` 独立于 Config 和 IndexedDB schema version。
- DTO 字段不得直接复用数据库记录的偶然结构。
- DTO 必须穷尽映射 HTTP、SSE 和 WebSocket Capture，并保留协议版本观测、fidelity、unavailable 原因和 Base64 Body。
- 新增可选字段保持同版本向后兼容；删除、改义或改变必填性需要新版本。
- 服务端必须以 batchId 幂等处理重复批次。
- receipt 必须关联 batchId；不接受含糊的任意 2xx 作为业务确认。

## 交付语义

客户端采用至少一次交付：网络超时可能发生在服务端已接收之后，因此 Capture 会保持 pending 并在之后重试。`batchId` 是 `schemaVersion + endpoint origin + 按顺序排列的 Capture ID` 规范编码后的 SHA-256；同一 pending 前缀重试得到稳定 batchId。服务端同时以 Capture ID 建立唯一约束，避免批次边界变化导致重复入库。

v1 不在 Capture 上实现复杂重试计数。退避和下一次调度由 Background 持有，Delivery 的一次 `flush()` 保持有界。

## 失败策略

- DTO 映射失败时不发送包含部分记录的批次，并返回可诊断错误。
- 超时、网络异常、无效 receipt 和非成功响应均不确认队列。
- `markDelivered` 失败时记录失败并允许重试；服务端需依赖幂等键处理重复发送。
- 日志不得输出 Authorization 或 Capture 正文。
- Transport 不跟随到未允许 origin 的重定向。

## 测试

- Capture 到各版本 DTO 的完整映射。
- 双重启用条件和关闭时零队列读取、零 HTTP。
- batchSize、确定顺序、client context 和 batchId。
- 并发 flush 单飞、超时、失败保留与成功确认。
- 无效 receipt、重定向和敏感日志约束。

## 扩展

服务端契约变化优先增加新的 DTO mapper 与 schemaVersion。Capture 和 IndexedDB schema 仅在内部事实模型确实变化时修改，不能为迎合远端字段命名而联动。