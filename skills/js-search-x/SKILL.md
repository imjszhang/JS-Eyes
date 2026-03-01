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
| `x_get_post` | 获取推文详情（含对话线程、回复、引用推文、链接卡片、视频多质量），支持批量 |
| `x_get_home_feed` | 获取首页推荐流（For You / Following） |

## 编程 API

```javascript
const { BrowserAutomation } = require('./lib/js-eyes-client');
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

### 推文详情返回字段（getPost / x_get_post）

`getPost` 返回的推文对象包含以下增强字段：

| 字段 | 说明 |
|------|------|
| `quoteTweet` | 引用推文（Quote Tweet）的完整信息（嵌套推文对象），无引用时为 `null` |
| `card` | 链接预览卡片（`name`、`title`、`description`、`url`、`thumbnailUrl`、`domain`），无卡片时为 `null` |
| `mediaDetails` | 增强版媒体详情数组：照片含尺寸，视频含多质量 mp4/m3u8 URL、时长、海报图 |
| `stats.quotes` | 引用次数（与 replies、retweets、likes、views、bookmarks 并列） |
| `lang` | 推文语言代码 |
| `isVerified` | 作者是否蓝标认证 |
| `conversationId` | 对话线程 ID |
| `inReplyToTweetId` | 被回复的推文 ID（非回复时为 `null`） |
| `inReplyToUser` | 被回复的用户名 |
| `source` | 发推来源（如客户端标识） |

> 注意：`searchTweets` / `getProfileTweets` / `getHomeFeed` 返回的推文结构较精简，不含 `quoteTweet`、`card`、`mediaDetails` 等详情字段。

## CLI 命令

```bash
# 搜索
node skills/js-search-x/index.js search "AI agent" --sort latest --max-pages 3

# 用户时间线
node skills/js-search-x/index.js profile elonmusk --max-pages 10

# 推文详情
node skills/js-search-x/index.js post https://x.com/user/status/123 --with-thread
# 推文详情 + 回复（翻页加载指定数量的回复）
node skills/js-search-x/index.js post https://x.com/user/status/123 --with-replies 50
# 抓完后关闭 tab（默认保留供下次复用）
node skills/js-search-x/index.js post https://x.com/user/status/123 --close-tab

# 对指定推文发表回复（先抓取该帖再发送回复；仅支持单条推文）
node skills/js-search-x/index.js post https://x.com/user/status/123 --reply "回复内容"
# 选择回复样式：reply（默认，Replying to @xxx 式）或 thread（点击推文下回复按钮）
node skills/js-search-x/index.js post https://x.com/user/status/123 --reply "回复内容" --reply-style thread
# 仅打印回复内容不实际发送
node skills/js-search-x/index.js post https://x.com/user/status/123 --reply "测试" --dry-run

# 发一条新帖（无需 URL/ID）
node skills/js-search-x/index.js post --post "新帖内容"
# 发帖时附带图片
node skills/js-search-x/index.js post --post "看看这张图" --image path/to/image.png
# Quote Tweet：引用帖并附评论（需与 --post 搭配，与 --reply/--thread 互斥）
node skills/js-search-x/index.js post --post "评论内容" --quote https://x.com/user/status/123
node skills/js-search-x/index.js post --post "评论" --quote 1234567890 --dry-run
# 发串推（thread：多条首尾相连）
node skills/js-search-x/index.js post --thread "段1" "段2" "段3" --thread-delay 2000
# 串推最大条数限制（默认25）
node skills/js-search-x/index.js post --thread "段1" "段2" --thread-max 10
# 发帖/串推/Quote Tweet 也可用 --dry-run 仅打印不发送

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

**发表回复**：`post` 命令支持 `--reply "内容"` 对指定推文发表回复（优先尝试 GraphQL CreateTweet，失败时回退到 DOM 点击回复框）。`--reply-style` 可选 `reply`（默认，标准 Replying to @xxx 式）或 `thread`（直接在推文下方点击回复按钮）。此为写操作，请注意 X 限流与账号安全；可使用 `--dry-run` 仅打印不发送。

**发新帖与串推**：`post` 命令支持 `--post "内容"` 发一条新帖，或 `--thread "段1" "段2" ...` 发 X 特色串推（第 2 条起依次回复上一条）。同样优先 GraphQL CreateTweet，失败时单条新帖可回退到首页 DOM 发推。串推支持 `--thread-delay`（段间延迟毫秒，默认 3500）、`--thread-max`（最大条数，默认 25）。均为写操作，请注意限流与账号安全；可使用 `--dry-run` 仅打印不发送。

**Quote Tweet（引用帖）**：`--post "评论" --quote <url_or_id>` 引用指定推文并附上评论。优先通过 GraphQL CreateTweet + `attachment_url` 发送，失败时回退到 DOM 自动化（打开推文页 → 点击 Repost → 选 Quote → 输入评论 → 点击 Post）。与 `--reply`、`--thread` 互斥；可使用 `--dry-run` 仅打印不发送。

**附带图片**：`--image <path>` 可在发新帖或串推第 1 条时附带一张图片。图片通过浏览器端的媒体上传流程处理。

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
│   ├── xUtils.js             # 共享工具函数
│   └── js-eyes-client.js     # JS-Eyes SDK 客户端
└── scripts/
    ├── x-search.js           # 搜索脚本
    ├── x-profile.js          # 用户时间线脚本
    ├── x-post.js             # 推文详情脚本
    └── x-home.js             # 首页推荐脚本
```
