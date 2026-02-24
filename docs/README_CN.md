# JS Eyes

<div align="center">

**AI Agent 浏览器自动化扩展**

通过 WebSocket 为 AI Agent 框架提供浏览器自动化控制能力

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![GitHub](https://img.shields.io/badge/GitHub-imjszhang%2Fjs--eyes-181717?logo=github)](https://github.com/imjszhang/js-eyes)
[![X (Twitter)](https://img.shields.io/badge/X-@imjszhang-000000?logo=x)](https://x.com/imjszhang)
[![Chrome](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome)](https://developer.chrome.com/docs/extensions/mv3/)
[![Firefox](https://img.shields.io/badge/Firefox-Manifest%20V2-FF7139?logo=firefox)](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions)

[English](../README.md) | [中文文档](#简介)

</div>

---

## 简介

JS Eyes 是一个浏览器自动化控制扩展，通过 WebSocket 与 AI Agent 框架通信。支持多种服务器后端，通过自动能力探测实现自适应连接。

> 💡 让 AI 助手能够帮你操作浏览器：打开页面、批量填写表单、提取数据、跨站操作

### 支持的 Agent 框架

| 框架 | 说明 |
|------|------|
| [js-eyes/server](../server) | 内置轻量版服务器（HTTP+WS 共用端口，无认证） |
| [OpenClaw](https://github.com/nicepkg/openclaw)（插件） | 注册为 OpenClaw 插件 — AI 工具、后台服务、CLI 命令 |
| [DeepSeek Cowork](https://github.com/imjszhang/deepseek-cowork) | 完整版 Agent 框架（独立 WS 端口、HMAC 认证、SSE、限流） |

## 功能特性

- 🔗 **实时 WebSocket 通信** - 与服务器建立持久连接
- 🔍 **自动服务器探测** - 自动发现服务器能力和端点配置
- 📊 **标签页管理** - 自动同步标签页信息到服务器
- 🎯 **远程控制** - 支持远程打开/关闭标签页、执行脚本等
- 📄 **内容获取** - 获取页面 HTML 内容、文本、链接等信息
- 🍪 **Cookie 管理** - 自动获取和同步页面 cookies
- 💉 **代码注入** - 支持 JavaScript 执行和 CSS 注入
- 📱 **状态监控** - 实时显示连接状态和扩展信息
- 🏥 **健康检查与熔断** - 服务健康监控，自动熔断保护
- 🔄 **SSE 降级** - WebSocket 连接失败时自动降级到 SSE（服务器支持时）
- ⚡ **限流与去重** - 请求速率限制和去重，提升稳定性
- 🔐 **自适应认证** - 自动检测服务器认证要求（HMAC-SHA256 或免认证）

## 支持的浏览器

| 浏览器 | 版本要求 | Manifest 版本 |
|--------|----------|---------------|
| Chrome | 88+ | V3 |
| Edge | 88+ | V3 |
| Firefox | 58+ | V2 |

## 下载

### 最新版本

从 [GitHub Releases](https://github.com/imjszhang/js-eyes/releases/latest) 下载最新版本：

- **Chrome/Edge 扩展**: `js-eyes-chrome-v1.4.0.zip`
- **Firefox 扩展**: `js-eyes-firefox-v1.4.0.xpi`

### 从源代码安装

如果你希望从源代码安装：

1. 克隆本仓库
2. 按照下面的安装步骤操作

## 安装步骤

### Chrome / Edge

1. 打开浏览器，访问 `chrome://extensions/`（Edge 访问 `edge://extensions/`）
2. 开启右上角的"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择 `chrome-extension` 文件夹
5. 扩展将被安装并激活

### Firefox

#### 临时安装（开发模式）

1. 打开 Firefox，访问 `about:debugging`
2. 点击"此 Firefox"
3. 点击"临时载入附加组件"
4. 选择 `firefox-extension/manifest.json` 文件

#### 已签名 XPI 安装

如果有已签名的 `.xpi` 文件：
1. 直接拖拽到 Firefox 浏览器窗口
2. 或在地址栏输入文件路径打开

## 使用说明

### 1. 启动兼容的服务器

**方式 A** — 内置轻量版服务器：
```bash
npm run server
# 在 http://localhost:18080 启动（HTTP + WebSocket）
```

**方式 B** — 作为 [OpenClaw](https://github.com/nicepkg/openclaw) 插件使用（参见下方 [OpenClaw 插件](#openclaw-插件) 章节）。

**方式 C** — 使用支持的 Agent 框架，如 [DeepSeek Cowork](https://github.com/imjszhang/deepseek-cowork)。

### 2. 配置连接

1. 点击浏览器工具栏中的扩展图标
2. 输入服务器 HTTP 地址（如 `http://localhost:18080`）
3. 点击"Connect"— 扩展会自动探测 WebSocket 端点和服务器能力
4. 如果服务器需要认证，在安全设置中配置认证密钥

**自动连接功能：**
- 扩展启动时会自动尝试连接服务器（如果启用自动连接）
- 连接断开后会自动重连（使用指数退避策略，无限重试）
- 可在设置中启用/禁用自动连接功能

### 3. 验证连接

- 扩展成功连接后，状态指示器显示"Connected"（绿色）
- "Server Type"显示检测到的服务器信息和能力
- 标签页信息会自动同步到服务器
- 可在 popup 中查看当前标签页和统计信息

## 故障排除

如果遇到连接问题：
- 确认服务器正在运行
- 检查服务器地址（使用 HTTP 地址，如 `http://localhost:18080`）
- 查看浏览器控制台错误信息
- 扩展会从 HTTP 地址自动探测 WebSocket 端点

## 构建与发布

### 前置条件

- Node.js >= 14
- 在项目根目录执行 `npm install`

### 构建命令

```bash
# 打包所有扩展（Firefox 自动签名）
npm run build

# 仅打包 Chrome 扩展
npm run build:chrome

# 打包并签名 Firefox 扩展
npm run build:firefox

# 同步版本号到所有 manifest
npm run bump -- 1.4.0
```

输出文件保存在 `dist/` 目录。详细文档见 [releases/README.md](../releases/README.md)。

## OpenClaw 插件

JS Eyes 可以作为 [OpenClaw](https://github.com/nicepkg/openclaw) 插件使用，为 OpenClaw AI Agent 直接提供浏览器自动化工具。

### 提供的能力

- **后台服务** — 自动启动/停止内置 WebSocket 服务器
- **7 个 AI 工具** — `js_eyes_get_tabs`、`js_eyes_list_clients`、`js_eyes_open_url`、`js_eyes_close_tab`、`js_eyes_get_html`、`js_eyes_execute_script`、`js_eyes_get_cookies`
- **CLI 命令** — `openclaw js-eyes status`、`openclaw js-eyes tabs`、`openclaw js-eyes server start/stop`

### 配置方法

1. 在浏览器中安装 JS Eyes 扩展（步骤同上）
2. 在 OpenClaw 配置文件（`~/.openclaw/openclaw.json`）中添加插件：

```json
{
  "plugins": {
    "load": {
      "paths": ["/path/to/JS-Eyes/openclaw-plugin"]
    },
    "entries": {
      "js-eyes": {
        "enabled": true,
        "config": {
          "serverPort": 18080,
          "autoStartServer": true
        }
      }
    }
  }
}
```

3. 启动 OpenClaw — 服务器自动启动，AI Agent 可通过注册的工具控制浏览器。

### 插件配置项

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `serverHost` | string | `"localhost"` | 服务器监听地址 |
| `serverPort` | number | `18080` | 服务器端口 |
| `autoStartServer` | boolean | `true` | 插件加载时自动启动服务器 |
| `requestTimeout` | number | `60` | 请求超时秒数 |

## 相关项目

- [OpenClaw](https://github.com/nicepkg/openclaw) - 可扩展插件系统的 AI Agent 框架
- [DeepSeek Cowork](https://github.com/imjszhang/deepseek-cowork) - 支持浏览器自动化的 AI Agent 框架

## 贡献

欢迎贡献！请随时提交 Pull Request。

1. Fork 本仓库
2. 创建功能分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 打开 Pull Request

## 许可证

本项目采用 MIT 许可证 - 详见 [LICENSE](../LICENSE) 文件。

## 作者

由 **[@imjszhang](https://x.com/imjszhang)** 创建

欢迎在 X 上关注我，获取项目更新、技术分享和更多开源项目！

---

<div align="center">

**为任何 AI Agent 框架提供浏览器自动化能力**

由 [@imjszhang](https://x.com/imjszhang) 用 ❤️ 构建

</div>
