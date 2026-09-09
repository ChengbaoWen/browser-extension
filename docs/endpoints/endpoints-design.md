# Endpoints 模块设计

本文描述 `src/endpoints/` 的 URL 匹配设计。系统级约束见 [architecture.md](../architecture.md)，文件位置见 [structure.md](../structure.md)。

## 目标

Endpoints 模块将 SystemConfig 中的 `EndpointRule` 编译成确定、快速且无副作用的 endpoint matcher。它只回答“该 HTTP(S) 或 WebSocket URL 是否命中哪条规则”，不执行采集。

## 边界

模块负责 URL 解析、规范化、规则预编译、优先级排序和匹配结果生成。模块不加载配置、不判断过期、不访问网络，也不持有可变全局状态。

## 文件

| 文件 | 设计职责 |
| :--- | :--- |
| `endpoint-matcher.ts` | 编译规则并返回封闭的 `EndpointMatcher` |

只有一个实现文件是刻意的。除非匹配语义真实增长，否则不拆分通用 URL 工具或规则类层次。

## 公开接口

```ts
type EndpointMatch =
  | { matched: true; ruleId: string; configRevision: string }
  | { matched: false };

interface EndpointMatcher {
  match(url: string, protocol: 'http' | 'websocket'): EndpointMatch;
}

function createEndpointMatcher(config: EndpointMatcherConfig): EndpointMatcher;
```

`EndpointMatcherConfig` 是 Config 从 SystemConfig 生成的最小投影，只包含 revision 和 endpoint rules。创建时读取并编译该不可变投影；调用 `match` 不再读取 Config Manager，因此一次 matcher 对应唯一 revision。

## 匹配语义

1. 使用标准 `URL` 解析输入，非法 URL 返回未命中。
2. 一条逻辑规则包含多个 host，每个 host 包含自己的 scheme、可选 port 和多个 path；规则不区分 request 与 response。
3. scheme 和 host 按 URL 标准规范化；host 精确匹配，HTTP 接受 `http/https`，WebSocket 接受 `ws/wss`。
4. 默认端口归一化，非默认端口必须显式一致。
5. path 只针对 URL 的 pathname，忽略 query 和 fragment，并通过显式 `match` 枚举选择算法：
  - `exact`：完整相等。
  - `prefix`：以配置值开头。
  - `suffix`：以配置值结尾。
  - `contains`：包含配置值。
  - `glob`：完整 pathname 模式匹配，其中 `*` 表示零个或多个字符，包括 `/`。
6. 除 `glob` 外不得使用 `*`；`glob` 必须至少包含一个 `*`。所有模式必须以 `/` 开头，不允许配置 query、fragment、正则表达式或可执行逻辑。
7. 若多个模式同时命中，按 endpoint、host、scheme、path 的配置展开顺序稳定决胜，返回所属 EndpointRule 的 ID。
8. Config 对展开后的 scheme × host × path 组合设置 256 条硬上限，并拒绝完全重复的组合。

当前 Gemini 网页聊天精确匹配 `gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate`。其动态 `bl`、`f.sid`、`_reqid` 和 `rt` 位于 query，不影响 pathname 匹配。该接口是 HTTP 流式 Google RPC，当前按普通 HTTP request/response 原始 Body 采集，不标记为 SSE。

## 不变量

- 相同配置和 URL 总是得到相同结果。
- 返回的 `configRevision` 与创建 matcher 的快照一致。
- 未命中结果不泄露内部解析错误。
- matcher 创建后不受后续配置对象或 Config Manager 更新影响。
- 模块不包含厂商名称或厂商特例。

## 性能

规则展开和 glob 编译只在 `createEndpointMatcher` 时发生。`match` 按配置顺序扫描最多 256 条已编译组合并比较 scheme、host、port 和 path；当前规则规模较小时优先保持实现简单，只有基准测试证明必要时才增加候选索引。

## 失败策略

- Config 模块应阻止非法规则进入本模块；构造函数仍对不可满足状态快速失败。
- 输入 URL 解析失败返回 `{ matched: false }`，不抛给页面代码。
- 空规则集返回始终未命中的 matcher。

## 测试

- scheme、host、默认与非默认端口。
- HTTP 与 WebSocket 规则隔离；HTTP/1/2/3 共用同一 HTTP URL 规则。
- 多 host、多 path，以及 exact、prefix、suffix、contains、glob 五种 path 模式。
- Host 大小写边界和 query/fragment 忽略。
- 非法 URL、空规则和大小写规范化。
- 多规则优先级、稳定决胜和 revision 固定。
- 配置更新通过创建新 matcher 生效，旧 matcher 行为不变。

## 扩展

新增匹配模式时必须先扩展 `EndpointPath.match` 的显式联合类型，再在本模块增加对应编译器。不得通过路径内容隐式推断模式，也不得允许远端下发 JavaScript 正则或可执行匹配逻辑。