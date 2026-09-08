# AI Chatbox Hook & Stream Inspector 🚀

一个基于 **Manifest V3 + WXT + TypeScript + React + Tailwind CSS** 构建的现代浏览器插件工程，专门用于实时 Hook 拦截各大 AI Chatbox 的网络请求，无损提取 Prompt 和流式/完整 Response 明文数据。

---

## ✨ 核心特性

1. **MAIN World 无损分流 Hook**：
   - 拦截并代理 `window.fetch`。
   - 使用 `ReadableStream.prototype.tee()` 将原始响应流分流为两份独立流，**完全不影响网页本身的打字机动画与正常交互**。
2. **多平台专用适配器 (Adapters)**：
   - **ChatGPT** (`chatgpt.com` / `chat.openai.com`) - SSE 增量拼接与 prompt 提取。
   - **Claude** (`claude.ai`) - `content_block_delta` 与 completion 流解析。
   - **DeepSeek** (`chat.deepseek.com`) - SSE 流与 OpenAI 标准 delta 协议解析。
   - **Kimi** (`kimi.moonshot.cn`) - 格式化流式文本抽取。
   - **通用 OpenAI 规范 WebUI** (`/v1/chat/completions`)。
   - **Generic Raw Fallback** - 任意私有 AI Web 平台自动降级保底捕获，确保不漏抓。
3. **多层 IPC 通信与实时渲染**：
   - MAIN World $\rightarrow$ `CustomEvent` $\rightarrow$ Content Script $\rightarrow$ `chrome.runtime.Port` $\rightarrow$ Background Service Worker $\rightarrow$ Side Panel UI。
4. **内置 Side Panel 检查器 (React 19 + Tailwind CSS)**：
   - 实时观察 Stream 增量生成。
   - 对话按平台/时间/状态分类，支持关键词全文搜索。
   - 单击一键复制 Prompt 与 Response 明文。
   - 一键导出为 **Markdown** 对话文档或 **JSON** 全量元数据文件。
5. **本地持久化与 Webhook 转发**：
   - 基于 IndexedDB 存储（自动维持最新 500 条滚动容量，防爆内存）。
   - 支持在设置面板配置自定义 Webhook URL，每次流结束自动向外部服务推送 JSON 负载。

---

## 🛠️ 项目结构

```text
├── src/
│   ├── entrypoints/
│   │   ├── background.ts       # Service worker: 数据汇总、IndexedDB持久化、Webhook转发
│   │   ├── content.ts          # Content script: 注入 injected.js 并桥接 Port 消息
│   │   ├── injected.ts         # MAIN world 注入脚本入口
│   │   └── sidepanel/          # Side Panel UI (React + Tailwind CSS)
│   │       ├── App.tsx
│   │       ├── index.html
│   │       └── main.tsx
│   ├── interceptor.ts          # fetch / ReadableStream.tee() 底层代理核心
│   ├── parsers/                # 各 AI 平台的流式解析适配器
│   │   ├── base.ts
│   │   ├── chatgpt.ts
│   │   ├── claude.ts
│   │   ├── deepseek.ts
│   │   ├── kimi.ts
│   │   ├── openai-generic.ts
│   │   └── generic-raw.ts
│   ├── types/                  # TypeScript 类型定义
│   └── utils/
│       ├── storage.ts          # IndexedDB 滚动存储封装
│       └── export.ts           # Markdown / JSON 导出工具
├── wxt.config.ts               # WXT 配置文件 (Manifest V3, Vite, Tailwind)
└── package.json
```

---

## 🚀 启动与调试

### 1. 开发模式 (支持热重载 HMR)
```bash
npm run dev
```
此命令会自动拉起安装了该扩展的 Chrome/Chromium 浏览器。

### 2. 生产打包
```bash
npm run build
```
打包输出目录为 `.output/chrome-mv3`。

### 3. 加载到 Chrome 浏览器
1. 打开 Chrome 浏览器，访问 `chrome://extensions/`。
2. 开启右上角 **"开发者模式" (Developer mode)**。
3. 点击 **"加载已解压的扩展程序" (Load unpacked)**。
4. 选择当前项目下的 `.output/chrome-mv3` 文件夹。
5. 访问任意 AI 聊天网站（如 ChatGPT、Claude、DeepSeek、Kimi 等），点击浏览器扩展栏的图标即可打开侧边栏实时观察捕获的 Prompt 与 Response！
