---
name: js-search-x
description: X.com (Twitter) content scraping skill — search tweets, get user timelines, fetch post details and home feed via browser automation.
version: 1.0.0
metadata:
  openclaw:
    emoji: "\U0001F50D"
    homepage: https://github.com/imjszhang/js-eyes
    requires:
      skills:
        - js-eyes
      bins:
        - node
---

# js-search-x

X.com (Twitter) 内容抓取技能 — 基于 js-eyes 浏览器自动化，通过 GraphQL API 拦截 + DOM 回退双策略获取推文数据。

## 依赖

本技能依赖 **js-eyes** 技能提供的浏览器自动化能力。使用前请确保：

1. JS-Eyes Server 已运行
2. 浏览器已安装 JS-Eyes 扩展并连接到服务器
3. 浏览器已登录 X.com

## 提供的 AI 工具

| 工具 | 说明 |
|------|------|
| `x_search_tweets` | 搜索 X.com 推文，支持关键词、排序、日期范围、互动数过滤等 |
| `x_get_profile` | 获取指定用户的时间线推文，支持翻页、日期筛选 |
| `x_get_post` | 获取推文详情（含对话线程和回复），支持批量 |
| `x_get_home_feed` | 获取首页推荐流（For You / Following） |

## 编程 API

```javascript
const { BrowserAutomation } = require('js-eyes-client');
const { searchTweets, getProfileTweets, getPost, getHomeFeed } = require('./lib/api');

const browser = new BrowserAutomation('ws://localhost:18080');

// 搜索推文
const result = await searchTweets(browser, 'AI agent', {
    maxPages: 3,
    sort: 'latest',
    minLikes: 10,
});

// 获取用户时间线
const profile = await getProfileTweets(browser, 'elonmusk', {
    maxPages: 10,
    since: '2025-01-01',
});

// 获取推文详情
const post = await getPost(browser, 'https://x.com/user/status/123', {
    withThread: true,
    withReplies: 50,
});

// 获取首页推荐
const feed = await getHomeFeed(browser, {
    feed: 'foryou',
    maxPages: 5,
});
```

所有 API 函数接收 `BrowserAutomation` 实例（由调用者创建），返回结构化 JSON 数据，不做文件 I/O 或 `process.exit`。

## CLI 命令

```bash
# 搜索
node skills/js-search-x/index.js search "AI agent" --sort latest --max-pages 3

# 用户时间线
node skills/js-search-x/index.js profile elonmusk --max-pages 10

# 推文详情
node skills/js-search-x/index.js post https://x.com/user/status/123 --with-thread

# 对指定推文发表回复（先抓取该帖再发送回复；仅支持单条推文）
node skills/js-search-x/index.js post https://x.com/user/status/123 --reply "回复内容"
# 仅打印回复内容不实际发送
node skills/js-search-x/index.js post https://x.com/user/status/123 --reply "测试" --dry-run

# 首页推荐
node skills/js-search-x/index.js home --feed foryou --max-pages 5
```

## 工作原理

1. 通过 js-eyes 在已登录 X.com 的浏览器标签页中注入脚本
2. 动态扫描 JS bundle 发现 GraphQL queryId 和 features（带本地缓存）
3. 使用 `fetch()` 调用 X.com GraphQL API（SearchTimeline / UserTweets / TweetDetail / HomeTimeline）
4. 解析 API 响应提取推文数据
5. GraphQL 失败时自动回退到 DOM 提取
6. 支持自动重试、queryId 过期重新发现、429 速率限制保护

**发表回复**：`post` 命令支持 `--reply "内容"` 对指定推文发表回复（优先尝试 GraphQL CreateTweet，失败时回退到 DOM 点击回复框）。此为写操作，请注意 X 限流与账号安全；可使用 `--dry-run` 仅打印不发送。

## 目录结构

```
skills/js-search-x/
├── SKILL.md                  # 技能描述（本文件）
├── package.json
├── index.js                  # CLI 入口
├── openclaw-plugin/
│   ├── openclaw.plugin.json  # OpenClaw 插件清单
│   ├── package.json
│   └── index.mjs             # 注册 4 个 AI 工具
├── lib/
│   ├── api.js                # 编程 API（核心）
│   └── xUtils.js             # 共享工具函数
└── scripts/
    ├── x-search.js           # 搜索脚本
    ├── x-profile.js          # 用户时间线脚本
    ├── x-post.js             # 推文详情脚本
    └── x-home.js             # 首页推荐脚本
```
