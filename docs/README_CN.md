# JS Eyes

<div align="center">

**AI Agent 浏览器自动化**

让 AI 智能体拥有浏览器的真实视角 — 基于 WebSocket 的自动化控制，原生支持 OpenClaw

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![GitHub](https://img.shields.io/badge/GitHub-imjszhang%2Fjs--eyes-181717?logo=github)](https://github.com/imjszhang/js-eyes)
[![Website](https://img.shields.io/badge/Website-js--eyes.com-FCD228?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjggMTI4Ij48cmVjdCB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgcng9IjE2IiBmaWxsPSIjRkNEMjI4Ii8+PHRleHQgeD0iNjQiIHk9IjY0IiBmb250LWZhbWlseT0ic2Fucy1zZXJpZiIgZm9udC1zaXplPSI3MiIgZm9udC13ZWlnaHQ9IjcwMCIgZmlsbD0iIzM3MzQyRiIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZG9taW5hbnQtYmFzZWxpbmU9ImNlbnRyYWwiPkpTPC90ZXh0Pjwvc3ZnPg==)](https://js-eyes.com)
[![X (Twitter)](https://img.shields.io/badge/X-@imjszhang-000000?logo=x)](https://x.com/imjszhang)
[![Chrome](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome)](https://developer.chrome.com/docs/extensions/mv3/)
[![Firefox](https://img.shields.io/badge/Firefox-Manifest%20V2-FF7139?logo=firefox)](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions)

[English](../README.md) | [中文文档](#一键安装)

</div>

---

## 一键安装

**Linux / macOS:**

```bash
curl -fsSL https://js-eyes.com/install.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://js-eyes.com/install.ps1 | iex
```

自动下载技能包、安装依赖，并输出 OpenClaw 插件注册路径。其他安装方式见[手动安装](#手动安装)。

---

## 简介

JS Eyes 是一个浏览器扩展 + WebSocket 服务器，为 AI 智能体提供完整的浏览器自动化能力。它连接 AI Agent 框架（OpenClaw、DeepSeek Cowork 或自定义），提供标签页管理、内容提取、脚本执行、Cookie 访问等工具。

```
浏览器扩展  <── WebSocket ──>  JS-Eyes 服务器  <── WebSocket ──>  AI Agent (OpenClaw)
(Chrome/Edge/FF)               (Node.js)                         (插件: index.mjs)
```

### 支持的 Agent 框架

| 框架 | 说明 |
|------|------|
| [js-eyes/server](../server) | 内置轻量版服务器（HTTP+WS 共用端口，无认证） |
| [OpenClaw](https://openclaw.ai/)（插件） | 注册为 OpenClaw 插件 — 9 个 AI 工具、后台服务、CLI 命令 |
| [DeepSeek Cowork](https://github.com/imjszhang/deepseek-cowork) | 完整版 Agent 框架（独立 WS 端口、HMAC 认证、SSE、限流） |

## 功能特性

- **实时 WebSocket 通信** — 与服务器建立持久连接
- **自动服务器探测** — 自动发现服务器能力和端点配置
- **标签页管理** — 自动同步标签页信息到服务器
- **远程控制** — 支持远程打开/关闭标签页、执行脚本
- **内容获取** — 获取页面 HTML、文本、链接
- **Cookie 管理** — 自动获取和同步页面 cookies
- **代码注入** — JavaScript 执行和 CSS 注入
- **健康检查与熔断** — 服务健康监控，自动熔断保护
- **SSE 降级** — WebSocket 连接失败时自动降级到 SSE
- **限流与去重** — 请求速率限制和去重，提升稳定性
- **自适应认证** — 自动检测服务器认证要求（HMAC-SHA256 或免认证）
- **扩展技能** — 发现并安装高级技能（如 X.com 搜索），基于基础自动化之上构建

## 支持的浏览器

| 浏览器 | 版本要求 | Manifest 版本 |
|--------|----------|---------------|
| Chrome | 88+ | V3 |
| Edge | 88+ | V3 |
| Firefox | 58+ | V2 |

## 下载

从 [GitHub Releases](https://github.com/imjszhang/js-eyes/releases/latest) 下载最新版本：

- **Chrome/Edge 扩展**: `js-eyes-chrome-v1.4.3.zip`
- **Firefox 扩展**: `js-eyes-firefox-v1.4.3.xpi`

或直接从 [js-eyes.com](https://js-eyes.com) 下载。

## 手动安装

### 浏览器扩展

#### Chrome / Edge

1. 打开浏览器，访问 `chrome://extensions/`（Edge 访问 `edge://extensions/`）
2. 开启右上角的"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择 `chrome-extension` 文件夹

#### Firefox

**已签名 XPI**（推荐）：将 `.xpi` 文件拖拽到 Firefox 窗口中。

**临时安装**（开发模式）：打开 `about:debugging` > 此 Firefox > 临时载入附加组件 > 选择 `firefox-extension/manifest.json`。

### OpenClaw 技能包

如果不使用[一键安装](#一键安装)，也可以手动安装：

1. 从 [js-eyes.com](https://js-eyes.com/js-eyes-skill.zip) 或 [GitHub Releases](https://github.com/imjszhang/js-eyes/releases/latest) 下载 `js-eyes-skill.zip`
2. 解压到目录（如 `./skills/js-eyes`）
3. 在解压目录中执行 `npm install`
4. 在 `~/.openclaw/openclaw.json` 中注册插件（见 [OpenClaw 插件](#openclaw-插件)）

## 使用说明

### 1. 启动兼容的服务器

**方式 A** — 内置轻量版服务器：
```bash
npm run server
# 在 http://localhost:18080 启动（HTTP + WebSocket）
```

**方式 B** — 作为 [OpenClaw](https://openclaw.ai/) 插件使用（参见下方 [OpenClaw 插件](#openclaw-插件) 章节）。

**方式 C** — 使用支持的 Agent 框架，如 [DeepSeek Cowork](https://github.com/imjszhang/deepseek-cowork)。

### 2. 配置连接

1. 点击浏览器工具栏中的扩展图标
2. 输入服务器 HTTP 地址（如 `http://localhost:18080`）
3. 点击"Connect"— 扩展会自动探测 WebSocket 端点和服务器能力
4. 如果服务器需要认证，在安全设置中配置认证密钥

**自动连接：** 扩展启动时自动连接，断线后指数退避自动重连。

### 3. 验证连接

```bash
openclaw js-eyes status
```

输出显示服务器运行时间、已连接扩展数和标签页数。

## OpenClaw 插件

JS Eyes 注册为 [OpenClaw](https://openclaw.ai/) 插件，为 AI Agent 直接提供浏览器自动化工具。

### 提供的能力

- **后台服务** — 自动启动/停止内置 WebSocket 服务器
- **9 个 AI 工具** — 浏览器自动化 + 技能发现与安装（见下表）
- **CLI 命令** — `openclaw js-eyes status`、`openclaw js-eyes tabs`、`openclaw js-eyes server start/stop`

| 工具 | 说明 |
|------|------|
| `js_eyes_get_tabs` | 获取所有打开的标签页列表（ID、URL、标题） |
| `js_eyes_list_clients` | 获取已连接的浏览器扩展客户端列表 |
| `js_eyes_open_url` | 在新标签页或已有标签页中打开 URL |
| `js_eyes_close_tab` | 关闭指定 ID 的标签页 |
| `js_eyes_get_html` | 获取标签页的完整 HTML 内容 |
| `js_eyes_execute_script` | 在标签页中执行 JavaScript 并返回结果 |
| `js_eyes_get_cookies` | 获取标签页对应域名的所有 Cookie |
| `js_eyes_discover_skills` | 查询技能注册表，列出可安装的扩展技能 |
| `js_eyes_install_skill` | 下载、解压并注册一个扩展技能 |

### 配置方法

1. 在浏览器中安装 JS Eyes 扩展（步骤同上）
2. 在 OpenClaw 配置文件（`~/.openclaw/openclaw.json`）中添加插件：

```json
{
  "plugins": {
    "load": {
      "paths": ["/path/to/skills/js-eyes/openclaw-plugin"]
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

3. 重启 OpenClaw — 服务器自动启动，AI Agent 可通过注册的工具控制浏览器。

### 插件配置项

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `serverHost` | string | `"localhost"` | 服务器监听地址 |
| `serverPort` | number | `18080` | 服务器端口 |
| `autoStartServer` | boolean | `true` | 插件加载时自动启动服务器 |
| `requestTimeout` | number | `60` | 请求超时秒数 |
| `skillsRegistryUrl` | string | `"https://js-eyes.com/skills.json"` | 扩展技能注册表 URL |
| `skillsDir` | string | `""` | 技能安装目录（空值则自动使用技能包内的 `skills/` 目录） |

## 扩展技能

JS Eyes 支持**扩展技能** — 基于基础浏览器自动化构建的高级能力。每个技能添加新的 AI 工具，可独立安装。

| 技能 | 说明 | 工具 |
|------|------|------|
| [js-search-x](../skills/js-search-x/) | X.com (Twitter) 内容抓取 — 搜索推文、用户时间线、推文详情、首页推荐 | `x_search_tweets`、`x_get_profile`、`x_get_post`、`x_get_home_feed` |

### 发现技能

AI Agent 可以自动发现可用技能：

```
# 通过 AI 工具
js_eyes_discover_skills

# 通过技能注册表
https://js-eyes.com/skills.json
```

### 安装扩展技能

**一键安装：**

```bash
# Linux / macOS（方式一：参数）
curl -fsSL https://js-eyes.com/install.sh | bash -s -- js-search-x

# Linux / macOS（方式二：环境变量，与 PowerShell 一致）
curl -fsSL https://js-eyes.com/install.sh | JS_EYES_SKILL=js-search-x bash

# Windows PowerShell
$env:JS_EYES_SKILL="js-search-x"; irm https://js-eyes.com/install.ps1 | iex
```

**通过 AI Agent：** Agent 调用 `js_eyes_install_skill`，传入技能 ID — 自动下载、解压、安装依赖并注册插件。

**手动安装：** 从 [js-eyes.com/skills/js-search-x/](https://js-eyes.com/skills/js-search-x/js-search-x-skill.zip) 下载技能 zip，解压到 `skills/js-eyes/skills/js-search-x/`，执行 `npm install`，然后在 `openclaw.json` 中添加插件路径。

## 构建与发布

### 前置条件

- Node.js >= 16
- 在项目根目录执行 `npm install`

### 构建命令

```bash
# 构建站点 (docs/) + 技能包 + skills.json 注册表
npm run build:site

# 仅打包 Chrome 扩展
npm run build:chrome

# 打包并签名 Firefox 扩展
npm run build:firefox

# 同步版本号到所有 manifest
npm run bump -- 1.4.3
```

输出文件保存在 `dist/` 目录。

## 故障排除

| 症状 | 解决方法 |
|------|----------|
| 扩展显示 "Disconnected" | 执行 `openclaw js-eyes status` 检查；确认 `autoStartServer` 为 `true` |
| `js_eyes_get_tabs` 返回空 | 点击扩展图标，确认地址正确，点击 Connect |
| `Cannot find module 'ws'` | 在技能根目录执行 `npm install` |
| 工具未出现在 OpenClaw 中 | 确认 `plugins.load.paths` 指向 `openclaw-plugin` 子目录 |
| Windows 路径找不到 | JSON 中使用正斜杠，如 `C:/Users/you/skills/js-eyes/openclaw-plugin` |

## 相关项目

- [OpenClaw](https://openclaw.ai/) — 可扩展插件系统的 AI Agent 框架
- [DeepSeek Cowork](https://github.com/imjszhang/deepseek-cowork) — 支持浏览器自动化的 AI Agent 框架

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

---

<div align="center">

**为任何 AI Agent 框架提供浏览器自动化能力**

[js-eyes.com](https://js-eyes.com) | [GitHub](https://github.com/imjszhang/js-eyes) | [@imjszhang](https://x.com/imjszhang)

</div>
