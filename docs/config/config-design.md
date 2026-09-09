# Config 模块设计

本文定义 `src/config/` 的系统级配置模型、来源、校验、投影和生命周期。系统关系见 [architecture.md](../architecture.md)，文件位置见 [structure.md](../structure.md)。

## 目标

Config 是整个扩展唯一的运行时配置管理模块。Endpoint rules 只是 `SystemConfig.capture.endpoints` 的一个字段，不代表整个配置系统。

Config 负责：

- 把不可信配置输入解析为完整、不可变、版本化的 `SystemConfig`。
- 管理 Capture、Channel、Storage、Delivery 和 Debug UI 的运行参数。
- 将完整配置裁剪为各运行上下文需要的最小投影。
- 将配置值约束在构建内安全策略之内。
- 在 Background 内原子替换同一个 revision，并通过完整 envelope 与 ACK 让其他上下文最终收敛。
- 支持当前随扩展发布的配置和未来 HTTP 配置来源。

Config 不负责执行 endpoint 匹配、采集、通信、存储或 delivery。模块仍拥有自己的行为接口；Entry Points 负责把配置投影注入对应模块。

## 文件

| 文件 | 设计职责 |
| :--- | :--- |
| `system-config.ts` | `SystemConfig`、各模块配置段和有效配置类型 |
| `config-contract.ts` | 外部 DTO schema、运行时校验、默认值与映射 |
| `config-source.ts` | `ConfigSource` 与来源元数据接口 |
| `config-manager.ts` | 初始化、刷新、来源回退、到期和 Background 内快照替换；当前不持久化配置缓存 |
| `config-projections.ts` | 生成 MAIN、ISOLATED、Background 和 Debug UI 最小投影 |
| `config-projection-store.ts` | 通过 `chrome.storage.local` 保存可公开给扩展页的只读投影 |
| `safety-policy.ts` | 构建时硬上限、允许 origin 和不可远端覆盖项 |
| `local-consent.ts` | 读取用户控制的 delivery 本地授权，不允许远端快照覆盖 |
| `bundled-config-source.ts` | 读取随扩展发布的完整系统配置 |
| `system-config.json` | 当前完整配置快照 |

未来新增 `http-config-source.ts` 和 `config-cache.ts`。禁止使用 `local-config` 命名，因为文件描述的是完整系统配置，而不是仅供本地调试的 URL 列表。

## SystemConfig

```ts
interface SystemConfig {
  schemaVersion: 1;
  revision: string;
  issuedAt: number;
  expiresAt: number | null;

  capture: {
    enabled: boolean;
    endpoints: EndpointRule[];
    http: {
      enabled: boolean;
      captureRequestBody: boolean;
      captureResponseBody: boolean;
      maxBodyBytes: number;
    };
    sse: {
      enabled: boolean;
      sources: Array<'fetch' | 'xhr' | 'event-source'>;
      maxEventBytes: number;
      maxStreamBytes: number;
    };
    websocket: {
      enabled: boolean;
      maxMessageBytes: number;
      maxConnectionBytes: number;
    };
  };

  channel: {
    maxFrameBytes: number;
    maxQueuedFrames: number;
    maxQueuedBytes: number;
    reconnectInitialDelayMs: number;
    reconnectMaxDelayMs: number;
  };

  storage: {
    warningBytes: number;
    hardLimitBytes: number;
    draftTtlMs: number;
  };

  delivery: {
    enabled: boolean;
    endpoint: string | null;
    batchSize: number;
    flushIntervalMs: number;
    timeoutMs: number;
  };

  debugUi: {
    refreshIntervalMs: number;
    pageSize: number;
    defaultBodyView: 'hex' | 'base64' | 'text';
  };

  observability: {
    logLevel: 'error' | 'warn' | 'info' | 'debug';
    retainDiagnostics: number;
  };
}

interface EndpointRule {
  id: string;
  hosts: EndpointHost[];
}

interface EndpointHost {
  schemes: Array<'http' | 'https' | 'ws' | 'wss'>;
  host: string;
  port?: number;
  paths: EndpointPath[];
}

interface EndpointPath {
  match: 'exact' | 'prefix' | 'suffix' | 'contains' | 'glob';
  value: string;
}
```

一条 EndpointRule 表示一个逻辑采集目标，不区分 request 和 response；命中后同一次 HTTP exchange 的请求与响应均按 CapturePolicy 采集。一个规则可包含多个 host，每个 host 拥有自己的 scheme、可选 port 和多个 path。HTTP/1、HTTP/2 和 HTTP/3 不需要三套 endpoint 规则；它们共享 `http`/`https` URL，实际版本由浏览器协商。WebSocket 使用 `ws`/`wss` 规则。

## 当前完整配置示例

```json
{
  "schemaVersion": 1,
  "revision": "2026-09-09.5",
  "issuedAt": 1788940800000,
  "expiresAt": null,
  "capture": {
    "enabled": true,
    "endpoints": [
      {
        "id": "ai-api",
        "hosts": [
          {
            "schemes": ["https"],
            "host": "api.example.com",
            "paths": [
              { "match": "exact", "value": "/v1/messages" },
              { "match": "prefix", "value": "/v2/conversations/" },
              { "match": "glob", "value": "/api/*/completion" }
            ]
          },
          {
            "schemes": ["wss"],
            "host": "socket.example.com",
            "paths": [
              { "match": "exact", "value": "/events" }
            ]
          }
        ]
      }
    ],
    "http": {
      "enabled": true,
      "captureRequestBody": true,
      "captureResponseBody": true,
      "maxBodyBytes": 16777216
    },
    "sse": {
      "enabled": true,
      "sources": ["fetch", "xhr", "event-source"],
      "maxEventBytes": 1048576,
      "maxStreamBytes": 67108864
    },
    "websocket": {
      "enabled": true,
      "maxMessageBytes": 4194304,
      "maxConnectionBytes": 67108864
    }
  },
  "channel": {
    "maxFrameBytes": 65536,
    "maxQueuedFrames": 512,
    "maxQueuedBytes": 8388608,
    "reconnectInitialDelayMs": 250,
    "reconnectMaxDelayMs": 10000
  },
  "storage": {
    "warningBytes": 402653184,
    "hardLimitBytes": 536870912,
    "draftTtlMs": 86400000
  },
  "delivery": {
    "enabled": false,
    "endpoint": null,
    "batchSize": 50,
    "flushIntervalMs": 60000,
    "timeoutMs": 15000
  },
  "debugUi": {
    "refreshIntervalMs": 2000,
    "pageSize": 100,
    "defaultBodyView": "text"
  },
  "observability": {
    "logLevel": "warn",
    "retainDiagnostics": 200
  }
}
```

## 安全策略与本地授权

SystemConfig 表达期望行为，但不能突破构建时 `SafetyPolicy`：

```ts
interface SafetyPolicy {
  captureLimits: {
    maxFrameBytes: number;
    maxHttpBodyBytes: number;
    maxSseEventBytes: number;
    maxSseStreamBytes: number;
    maxWebSocketMessageBytes: number;
    maxWebSocketConnectionBytes: number;
  };
  channelLimits: {
    maxQueuedFrames: number;
    maxQueuedBytes: number;
    maxReconnectDelayMs: number;
  };
  storageHardLimitBytes: number;
  allowedConfigOrigins: string[];
  allowedDeliveryOrigins: string[];
}

interface LocalConsent {
  deliveryEnabled: boolean;
}
```

- 有效 SystemConfig 数值取请求值与 SafetyPolicy 上限的较小值。
- 远端配置不能扩大采集范围之外的 host 权限，也不能修改允许的服务 origin。
- Capture 的有效启用条件是 `config.capture.enabled`，安装后不需要本地开关操作。
- delivery 的有效启用条件是 `config.delivery.enabled && localConsent.deliveryEnabled`。
- `LocalConsent` 是 delivery 用户授权状态，由 Config Manager 组合进有效投影，但 bundled、缓存和远端快照都不能写入或覆盖它。该授权默认 false，必须由扩展自身的明确用户操作开启。
- 鉴权 token、cookie 和私钥不进入 SystemConfig；v1 不包含凭据字段，未来若增加 credential ID 必须扩展 schema 并由受控凭据模块解析。
- Side Panel 始终进入扩展产物，其刷新频率、分页大小和默认 Body 视图由 SystemConfig 配置。

## 配置投影

完整 SystemConfig 只保留在 Background。Config 模块输出以下最小投影：

| 投影 | 接收者 | 内容 |
| :--- | :--- | :--- |
| `MainCaptureConfig` | MAIN | revision、endpoint rules、HTTP/SSE/WebSocket 开关及采集上限 |
| `IsolatedChannelConfig` | ISOLATED | Frame、队列和重连限制 |
| `StorageConfig` | Background Storage | 容量水位和草稿 TTL |
| `DeliveryConfig` | Background Delivery | 有效启用状态、endpoint、批次、周期和超时 |
| `DebugUiConfig` | 开发 Side Panel | 刷新周期、分页大小和默认 Body 视图；通过 ConfigProjectionStore 读取 |
| `ObservabilityConfig` | Background | 日志级别和诊断保留数量 |

MAIN 不接收 delivery endpoint、Debug UI 设置或其他无关字段。投影保留相同 `revision`，便于诊断同一时刻各模块使用的配置。

Background 在原子切换后将无敏感信息的 `DebugUiConfig` 写入 `ConfigProjectionStore`。Side Panel 通过 Config 模块只读加载该投影；这不是 UI 专用消息协议，也不允许 UI 读取完整 SystemConfig。

各业务模块仍拥有自己的最小配置接口，例如 `CapturePolicy`、`ChannelPolicy` 和 `StoragePolicy`。Config 投影以结构类型满足这些接口，Entry Points 负责注入；业务模块不反向导入 Config Manager 或配置来源实现。

## 公开接口

```ts
interface ConfigSource {
  load(): Promise<unknown>;
}

interface ConfigManager {
  initialize(): Promise<SystemConfig | null>;
  reload(): Promise<ConfigRefreshResult>;
  current(): SystemConfig | null;
  projection<T extends ConfigProjection>(name: T): ProjectionValue<T> | null;
  subscribe(listener: (config: SystemConfig | null) => void): () => void;
}

function parseSystemConfig(
  input: unknown,
  safetyPolicy: SafetyPolicy,
  now: number
): SystemConfig;
```

`ConfigSource.load()` 返回 `unknown`，所有来源都必须经过同一个信任边界。调用者不能直接读取 `system-config.json`。

## 来源与优先级

- 当前使用 `BundledConfigSource`，读取随扩展发布的 `system-config.json`。
- 服务端就绪后使用 `HttpConfigSource`，并增加最后一次有效快照缓存。
- Config Manager 每次只接受一个完整快照，不对不同 revision 做字段级合并。
- LocalConsent 与 SafetyPolicy 是独立约束输入，不参与远端字段合并。

初始化和当前快照到期时执行同一个确定性选择流程：

1. 加载 remote；只有通过 schema、SafetyPolicy、origin、签名/完整性要求和有效期校验的未过期快照才是候选。无效 remote 不写缓存。
2. remote 不可用时读取 cache；cache 必须重新经过当前扩展版本的完整校验且未过期，不能因曾经有效而跳过 SafetyPolicy。
3. cache 不可用时读取 bundled snapshot，并经过同一 schema 与 SafetyPolicy 校验；bundled 可以使用 `expiresAt: null`。
4. 三者都不可用时生成代码内最小安全关闭配置：Capture 与 Delivery 关闭，Channel 与 Storage 使用 SafetyPolicy 内的固定保守值。

remote 候选激活后尽力写 cache；缓存写失败只产生诊断，不撤销已验证的内存快照。`reload()` 失败时，若当前快照仍未过期则继续使用当前快照，不降级到更旧来源；只有初始化无快照或当前快照到期时才执行 cache/bundled 回退。Service Worker 通过 `chrome.alarms` 和每次入口唤醒时的过期检查触发刷新，不依赖常驻计时器。

## 生命周期

1. Background 创建 ConfigSource、SafetyPolicy、LocalConsent source 和 Config Manager。
2. Manager 加载 `unknown`，执行 schema、安全上限、origin、大小和有效期校验。
3. 成功后先构造并校验全部投影；任一投影失败时不改变当前快照。
4. Manager 在 Background 内一次替换 SystemConfig、StorageConfig、DeliveryConfig 和 DebugUiConfig 引用；这里的“原子”只表示本上下文不会观察到混合字段，不声称多个 Chrome context 在同一时刻切换。
5. Background 通过 Channel 发布同时包含 MAIN 与 ISOLATED 投影的完整 revision envelope，并跟踪每个 tab/frame 的 ACK。旧 revision 交互继续被 Storage 接受；新 revision 只影响收到并确认该快照后开始的新交互。
6. 发布失败不回滚 Background 已验证快照，也不覆盖目标上下文最后确认的快照；Background 重试同一完整 envelope。相同 SystemConfig revision 可因 LocalConsent 改变重新生成投影，但不视为新配置版本。
7. 当前快照到期后执行来源选择流程；若没有有效来源则切换到安全关闭配置。

`ConfigRefreshResult` 必须区分 `activated`、`unchanged`、`retained-current` 和 `safe-disabled`，并携带来源与 revision；跨上下文 ACK 状态属于 Channel 诊断，不伪装为配置已全局同步。

## 校验规则

- 所有模块配置段必须存在，不允许静默依赖散落在代码中的默认值。
- 未知字段默认拒绝，避免拼写错误悄悄失效。
- 数值必须有限、非负并处于 SafetyPolicy 上限内；warning 必须小于 hard limit。
- EndpointRule ID 唯一；每条规则必须包含至少一个 host，每个 host 必须包含 scheme 和至少一个 path。
- Host 大小写归一化后精确匹配，不支持 host 通配符；同一 host 的多个 path 必须挂在该 host 下。
- Path `match` 只能是 `exact`、`prefix`、`suffix`、`contains` 或 `glob`。只有 `glob` 可包含 `*`，不接受正则表达式。
- Path 只匹配 URL pathname，必须以 `/` 开头，不得包含 query 或 fragment；展开后的 scheme × host × path 组合最多 256 条。
- delivery endpoint 必须为 HTTPS 且 origin 被 SafetyPolicy 允许。
- `expiresAt` 不早于 `issuedAt`；HTTP 来源不得永久有效。
- 配置序列化大小和数组长度有固定上限。

## 不变量

- SystemConfig 是完整不可变快照，不做增量 patch。
- 所有模块投影来自同一个已验证 revision。
- 模块不得自行读取配置文件或设置未经 Config 管理的运行时默认值。
- SafetyPolicy 和 LocalConsent 的限制优先于 SystemConfig。
- 配置切换只影响确认新 revision 后开始的 HTTP exchange、SSE stream 或 WebSocket connection；排队帧始终保留其原 revision 和入队时策略。

## 失败策略

- 首次加载和 fallback 均失败时使用安全关闭配置：Capture 与 Delivery 关闭，Channel/Storage 保留最小安全参数。
- 订阅者异常彼此隔离，不阻止其他模块切换配置。
- 某个投影生成失败时拒绝整个 snapshot，不能让 Background 内部分模块进入新 revision。
- 跨上下文发布依赖完整 envelope、ACK 和重试实现最终收敛；不可达上下文继续使用最后确认快照，不接收字段级混合版本。
- 缓存写入失败不影响已经验证的内存快照，但必须记录诊断。

## 测试

- 完整配置及每个模块配置段的 schema、默认值和未知字段。
- SafetyPolicy 上限、origin 限制与 LocalConsent 优先级。
- Bundled、HTTP、缓存回退和过期策略。
- 原子 revision 切换、投影最小化和订阅者隔离。
- HTTP/SSE/WebSocket 开关及所有容量参数传播。
- Endpoint 多 host、多 path、五种 path match、重复规则和展开数量上限。
- 配置失败时的安全关闭行为。