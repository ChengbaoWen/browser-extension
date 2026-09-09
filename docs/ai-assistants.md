# 已支持的 AI 聊天助手

本文记录扩展当前已配置并可采集的 AI 聊天服务。内容以 `src/config/system-config.json` 为准，对应配置 `schemaVersion: 1`、revision `2026-09-09.5`。

## 支持列表

| AI 服务 | 使用入口 | Endpoint ID | Host | Path | 当前采集方式 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| DeepSeek | 网页版 | `deepseek-web-chat` | `chat.deepseek.com` | `/api/v0/chat/completion` | XHR/HTTP；SSE 文本响应按 decoded text projection 采集 |
| ChatGPT | 网页版 | `chatgpt-web-conversation` | `chatgpt.com` | `/backend-api/f/conversation` | Fetch/HTTP；SSE 响应按 event 采集 |
| Dola | 网页版 | `dola-web-chat` | `www.dola.com` | `/chat/completion` | Fetch/HTTP；SSE 响应按 event 采集 |
| Gemini | 网页版 | `gemini-web-chat` | `gemini.google.com` | `/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate` | XHR/HTTP；Google RPC 文本响应按 decoded text projection 采集 |

## 支持范围

扩展仅采集命中上述 endpoint 的请求，不会采集对应网站的全部网络流量。匹配规则使用 HTTPS host 和精确 pathname；动态 query 参数不参与匹配。

所有已配置服务共享以下能力：

- 保存页面可观测的 HTTP request 和 response，包括 method、URL、status、Headers 和 Body。
- Body 以 Base64 字节数据保存，并可在 Side Panel 中切换 Text、Hex 和 Base64 视图。
- 支持 Fetch 和 XMLHttpRequest。
- 响应为 `text/event-stream` 时，按 SSE stream open、event、stream close 分别保存。
- 如果命中的 endpoint 使用 WebSocket，可记录连接生命周期和双向消息。
- 数据默认保存在本机 IndexedDB；当前 bundled 配置不向远端发送。

## 服务说明

### DeepSeek

支持 DeepSeek 网页聊天主 completion endpoint。文本型 XHR SSE 是浏览器解码后的文本投影，不声明为网络原始 bytes。

### ChatGPT

支持 ChatGPT 网页对话主 endpoint。请求与响应 Body 保持通用 HTTP/SSE 数据结构，不解析 conversation JSON 或提取消息字段。

### Dola

支持 Dola 网页聊天 completion endpoint。请求可能由 `Request` 对象发送，扩展会在页面消费 Body 前读取安全副本。

### Gemini

支持 Gemini 网页聊天的 `StreamGenerate` 主 endpoint。虽然名称包含 `StreamGenerate`，该接口不是 SSE，而是 `application/json` 响应中的 Google 私有 RPC 数据块。

Gemini 请求中的 `f.req` 按 `application/x-www-form-urlencoded` 原始表单文本保存。响应通过文本型 XHR 暴露，因此扩展保存浏览器解码后的 UTF-8 投影，并标记为 `decoded-text-projection`；当前不解析 XSSI 前缀、长度前缀或 Google RPC 内部结构，也不将其伪装成 SSE。

## 使用注意

- 安装或重新加载新构建后，需要刷新已打开的 AI 网站页面，使 MAIN world 采集脚本重新注入。
- 仅新发起且命中规则的请求会被采集，刷新扩展前的历史请求不会补录。
- 网站可能随时更改 host、path 或传输方式；规则失效时应以浏览器 DevTools 中的实际请求为依据更新配置。
- 页面 API 无法暴露的 Cookie、浏览器内部 Header、线上压缩字节和 HTTP/2/3 frame 不在采集保证范围内。
- 采集数据可能包含提示词、回复、Authorization 和其他敏感信息，只应在可信设备及获授权的页面中使用。
