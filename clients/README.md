# JS-Eyes Node.js Client

通过 WebSocket 与 JS-Eyes Server 通信，控制浏览器扩展执行自动化操作的 Node.js 客户端。

单文件设计，可直接复制 `js-eyes-client.js` 到任意项目中使用。

## 依赖

```bash
npm install ws
```

## 快速开始

```javascript
const { BrowserAutomation } = require('./js-eyes-client');

const bot = new BrowserAutomation('ws://localhost:18080');

await bot.connect();

// 获取所有标签页
const { tabs } = await bot.getTabs();
console.log(tabs);

// 打开新标签页
const tabId = await bot.openUrl('https://example.com');

// 获取页面 HTML
const html = await bot.getTabHtml(tabId);

// 执行脚本
const title = await bot.executeScript(tabId, 'document.title');

// 获取 cookies
const cookies = await bot.getCookies(tabId);

// 关闭标签页
await bot.closeTab(tabId);

// 断开连接
bot.disconnect();
```

## 构造函数

```javascript
new BrowserAutomation(serverUrl, options)
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `serverUrl` | `string` | `'ws://localhost:18080'` | 服务器地址（支持 `ws://`、`http://`、纯 host:port） |
| `options.requestInterval` | `number` | `200` | 请求最小间隔（ms） |
| `options.defaultTimeout` | `number` | `60` | 默认请求超时（秒） |
| `options.logger` | `object` | `console` | 日志对象，需实现 `info`/`warn`/`error` |

## API

所有方法均为 async，支持 `options.target` 参数指定目标浏览器（clientId 或浏览器名如 `'firefox'`、`'chrome'`）。

### 连接管理

| 方法 | 说明 |
|------|------|
| `connect()` | 建立 WebSocket 连接 |
| `disconnect()` | 主动断开连接 |
| `ensureConnected()` | 懒连接（未连接时自动连接） |

### 查询

| 方法 | 返回值 | 说明 |
|------|--------|------|
| `getTabs()` | `{ browsers, tabs, activeTabId }` | 获取所有标签页 |
| `listClients()` | `Array` | 获取已连接的浏览器扩展列表 |

### 标签页操作

| 方法 | 返回值 | 说明 |
|------|--------|------|
| `openUrl(url, tabId?, windowId?)` | `number` (tabId) | 打开 URL 或导航已有标签页 |
| `closeTab(tabId)` | `void` | 关闭标签页 |
| `getTabHtml(tabId)` | `string` | 获取标签页 HTML |
| `executeScript(tabId, code)` | `any` | 执行 JavaScript 代码 |
| `injectCss(tabId, css)` | `void` | 注入 CSS 样式 |
| `getCookies(tabId)` | `Array` | 获取标签页 cookies |

### 多浏览器支持

当多个浏览器扩展同时连接时，操作类方法可通过 `target` 参数指定目标浏览器：

```javascript
// 查看已连接的浏览器
const clients = await bot.listClients();
// [{ clientId: 'xxx', browserName: 'firefox', tabCount: 3 }, ...]

// 指定 Firefox 浏览器打开 URL
const tabId = await bot.openUrl('https://example.com', null, null, { target: 'firefox' });

// 指定具体的 clientId 获取 HTML
const html = await bot.getTabHtml(tabId, { target: clients[0].clientId });
```

不传 `target` 时，服务端默认选择第一个可用的扩展。

> 注意：`getTabs()` 和 `listClients()` 始终返回所有浏览器的数据，`target` 对这两个查询方法无效。

## 特性

- **自动重连**: 连接断开后自动指数退避重连（2s → 4s → 8s → ... → 60s）
- **懒连接**: 调用业务方法时自动建立连接，无需手动 `connect()`
- **速率控制**: 内置请求间隔保护，避免触发服务端限流
- **进程清理**: SIGINT/SIGTERM/exit 时自动断开连接
- **超时保护**: 每个请求独立超时，防止无响应阻塞

## 兼容性

- Node.js >= 16
- js-eyes/server >= 1.0.0
- 支持 Firefox Extension 和 Chrome Extension
