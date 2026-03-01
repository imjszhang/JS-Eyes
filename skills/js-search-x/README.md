# JS-Eyes Example: X.com 内容抓取

基于 JS-Eyes SDK 的 X.com (Twitter) 内容抓取工具，展示如何利用 JS-Eyes 的浏览器自动化能力构建实际应用。

## 功能

| 命令 | 说明 |
|------|------|
| `search <keyword>` | 按关键词搜索推文，支持高级筛选 |
| `profile <username>` | 抓取指定用户的推文时间线 |
| `post <url_or_id>` | 抓取推文详情，支持对话线程和回复；也可发回复、新帖、串推 |
| `home` | 抓取首页推荐流（For You / Following） |

## 前提条件

1. **JS-Eyes Server** 运行中（默认 `ws://localhost:18080`）
2. **浏览器扩展** 已安装并连接到 Server
3. 浏览器中已**登录 X.com**

## 安装

```bash
# 在 js-eyes 根目录安装依赖（ws 模块）
cd skills/js-search-x
npm install
```

## 使用

```bash
# 搜索
node index.js search "AI agent" --max-pages 3
node index.js search "机器学习" --lang zh --sort latest

# 用户时间线
node index.js profile elonmusk --max-pages 10

# 推文详情
node index.js post https://x.com/user/status/1234567890 --with-thread
node index.js post https://x.com/user/status/1234567890 --with-replies 50

# 回复推文
node index.js post https://x.com/user/status/1234567890 --reply "回复内容"

# 发新帖 / 串推 / 引用帖
node index.js post --post "新帖内容"
node index.js post --post "看看这张图" --image path/to/image.png
node index.js post --post "评论" --quote https://x.com/user/status/1234567890
node index.js post --thread "段1" "段2" "段3" --thread-delay 2000

# 首页推荐
node index.js home --feed following --max-pages 5
```

## 工作原理

本示例通过 JS-Eyes SDK（`clients/js-eyes-client.js`）与浏览器交互：

1. **Tab 复用**：智能复用已打开的 x.com 标签页，避免重复创建
2. **GraphQL API 调用**：在浏览器上下文中注入脚本，利用已有登录会话调用 X.com 的 GraphQL API
3. **DOM 提取兜底**：当 GraphQL API 不可用时，回退到 DOM 解析方式
4. **断点续传**：支持中断后恢复，边抓边保存

### 使用的 JS-Eyes API

```javascript
const { BrowserAutomation } = require('./lib/js-eyes-client');
const { searchTweets, getProfileTweets, getPost, getHomeFeed } = require('./lib/api');

const browser = new BrowserAutomation('ws://localhost:18080');

// 编程 API — 推荐用法
const result = await searchTweets(browser, 'AI agent', { maxPages: 3 });
const profile = await getProfileTweets(browser, 'elonmusk', { maxPages: 10 });
const post = await getPost(browser, 'https://x.com/user/status/123', { withThread: true });
const feed = await getHomeFeed(browser, { feed: 'foryou', maxPages: 5 });

// 底层 JS-Eyes SDK 能力
const tabs = await browser.getTabs();
const tabId = await browser.openUrl('https://x.com/home');
const data = await browser.executeScript(tabId, `
  // 此代码在浏览器上下文中执行，可访问页面 DOM 和 API
  const response = await fetch('/graphql/...', { headers: ... });
  return await response.json();
`);
await browser.closeTab(tabId);
```

## 输出

结果保存为 JSON 文件：

```
work_dir/scrape/
├── x_com_search/{keyword}_{timestamp}/data.json
├── x_com_profile/{username}_{timestamp}/data.json
├── x_com_post/{tweetId}_{timestamp}/data.json
└── x_com_home/{feed}_{timestamp}/data.json
```

## 免责声明

本示例仅供学习和个人研究使用。请遵守 X.com 的服务条款和使用政策。
