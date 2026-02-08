# JS Eyes

<div align="center">

**DeepSeek Cowork 浏览器扩展组件**

为 [DeepSeek Cowork](https://github.com/imjszhang/deepseek-cowork) 提供浏览器自动化控制能力

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![GitHub](https://img.shields.io/badge/GitHub-imjszhang%2Fjs--eyes-181717?logo=github)](https://github.com/imjszhang/js-eyes)
[![X (Twitter)](https://img.shields.io/badge/X-@imjszhang-000000?logo=x)](https://x.com/imjszhang)
[![Chrome](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome)](https://developer.chrome.com/docs/extensions/mv3/)
[![Firefox](https://img.shields.io/badge/Firefox-Manifest%20V2-FF7139?logo=firefox)](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions)

[English](../README.md) | [中文文档](#简介)

</div>

---

## 简介

JS Eyes 是 [DeepSeek Cowork](https://github.com/imjszhang/deepseek-cowork) 的浏览器扩展组件，通过 WebSocket 与 DeepSeek Cowork 服务器通信，实现浏览器自动化控制功能。

> 💡 让 AI 助手能够帮你操作浏览器：打开页面、批量填写表单、提取数据、跨站操作

## 功能特性

- 🔗 **实时 WebSocket 通信** - 与 DeepSeek Cowork 服务器建立持久连接
- 📊 **标签页管理** - 自动同步标签页信息到服务器
- 🎯 **远程控制** - 支持远程打开/关闭标签页、执行脚本等
- 📄 **内容获取** - 获取页面 HTML 内容、文本、链接等信息
- 🍪 **Cookie 管理** - 自动获取和同步页面 cookies
- 💉 **代码注入** - 支持 JavaScript 执行和 CSS 注入
- 📱 **状态监控** - 实时显示连接状态和扩展信息
- 🏥 **健康检查与熔断** - 服务健康监控，自动熔断保护
- 🔄 **SSE 降级** - WebSocket 连接失败时自动降级到 SSE
- ⚡ **限流与去重** - 请求速率限制和去重，提升稳定性
- 🔐 **HMAC 认证** - 使用 HMAC-SHA256 安全认证与服务器通信

## 支持的浏览器

| 浏览器 | 版本要求 | Manifest 版本 |
|--------|----------|---------------|
| Chrome | 88+ | V3 |
| Edge | 88+ | V3 |
| Firefox | 58+ | V2 |

## 下载

### 最新版本

从 [GitHub Releases](https://github.com/imjszhang/js-eyes/releases/latest) 下载最新版本：

- **Chrome/Edge 扩展**: `js-eyes-chrome-v1.3.3.zip`
- **Firefox 扩展**: `js-eyes-firefox-v1.3.3.xpi`

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

### 1. 启动 DeepSeek Cowork 服务器

确保 DeepSeek Cowork 应用正在运行，WebSocket 服务器默认监听端口 8080。

### 2. 配置连接

1. 点击浏览器工具栏中的扩展图标
2. 在弹出窗口中检查连接状态
3. 如需修改服务器地址，在设置中更改
4. 点击"Connect"按钮应用新设置并连接

**自动连接功能：**
- 扩展启动时会自动尝试连接服务器（如果启用自动连接）
- 连接断开后会自动重连（使用指数退避策略，无限重试）
- 可在设置中启用/禁用自动连接功能

### 3. 验证连接

- 扩展成功连接后，状态指示器显示"Connected"（绿色）
- 标签页信息会自动同步到服务器
- 可在 popup 中查看当前标签页和统计信息

## 故障排除

如果遇到连接问题：
- 确认 DeepSeek Cowork 应用正在运行
- 检查服务器地址和端口设置
- 查看浏览器控制台错误信息

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

## 相关项目

- [DeepSeek Cowork](https://github.com/imjszhang/deepseek-cowork) - 主项目

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

**让 AI 浏览器自动化触手可及**

由 [@imjszhang](https://x.com/imjszhang) 用 ❤️ 构建

</div>
