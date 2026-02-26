import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { BrowserAutomation } = require("../lib/js-eyes-client.js");
const { searchTweets, getProfileTweets, getPost, getHomeFeed } = require("../lib/api.js");

export default function register(api) {
  const cfg = api.pluginConfig ?? {};
  const serverUrl = cfg.jsEyesServerUrl || "ws://localhost:18080";
  const defaultMaxPages = cfg.defaultMaxPages || 3;

  let bot = null;

  function ensureBot() {
    if (!bot) {
      bot = new BrowserAutomation(serverUrl, {
        defaultTimeout: cfg.requestTimeout || 60,
        logger: {
          info: (m) => api.logger.info(m),
          warn: (m) => api.logger.warn(m),
          error: (m) => api.logger.error(m),
        },
      });
    }
    return bot;
  }

  function textResult(text) {
    return { content: [{ type: "text", text }] };
  }

  function jsonResult(obj) {
    return textResult(JSON.stringify(obj, null, 2));
  }

  // -------------------------------------------------------------------------
  // Tool: x_search_tweets
  // -------------------------------------------------------------------------

  api.registerTool(
    {
      name: "x_search_tweets",
      label: "X Search: Search Tweets",
      description:
        "搜索 X.com (Twitter) 推文。支持关键词搜索、排序、日期范围、作者过滤、互动数过滤等。返回结构化推文数据（含作者、内容、统计、媒体）。",
      parameters: {
        type: "object",
        properties: {
          keyword: {
            type: "string",
            description: "搜索关键词",
          },
          maxPages: {
            type: "number",
            description: `最多翻页数，每页约20条（默认 ${defaultMaxPages}）`,
          },
          sort: {
            type: "string",
            enum: ["top", "latest", "media"],
            description: "排序方式：top（热门）、latest（最新）、media（媒体）",
          },
          lang: {
            type: "string",
            description: "搜索语言代码（如 zh、en、ja）",
          },
          from: {
            type: "string",
            description: "指定作者用户名（不带 @）",
          },
          since: {
            type: "string",
            description: "起始日期 YYYY-MM-DD",
          },
          until: {
            type: "string",
            description: "截止日期 YYYY-MM-DD",
          },
          minLikes: {
            type: "number",
            description: "最低点赞数过滤",
          },
          minRetweets: {
            type: "number",
            description: "最低转发数过滤",
          },
          excludeReplies: {
            type: "boolean",
            description: "排除回复",
          },
          excludeRetweets: {
            type: "boolean",
            description: "排除转推",
          },
        },
        required: ["keyword"],
      },
      async execute(_id, params) {
        const b = ensureBot();
        const result = await searchTweets(b, params.keyword, {
          maxPages: params.maxPages || defaultMaxPages,
          sort: params.sort || "top",
          lang: params.lang,
          from: params.from,
          since: params.since,
          until: params.until,
          minLikes: params.minLikes || 0,
          minRetweets: params.minRetweets || 0,
          excludeReplies: params.excludeReplies || false,
          excludeRetweets: params.excludeRetweets || false,
          logger: {
            log: (m) => api.logger.info(m),
            warn: (m) => api.logger.warn(m),
            error: (m) => api.logger.error(m),
          },
        });
        return jsonResult(result);
      },
    },
    { optional: true },
  );

  // -------------------------------------------------------------------------
  // Tool: x_get_profile
  // -------------------------------------------------------------------------

  api.registerTool(
    {
      name: "x_get_profile",
      label: "X Search: Get Profile Tweets",
      description:
        "获取 X.com 指定用户的时间线推文。返回用户资料和推文列表。支持翻页、日期筛选、互动数过滤。",
      parameters: {
        type: "object",
        properties: {
          username: {
            type: "string",
            description: "用户名（不带 @）",
          },
          maxPages: {
            type: "number",
            description: `最多翻页数（默认 ${defaultMaxPages}）`,
          },
          maxTweets: {
            type: "number",
            description: "最多返回推文数（0 = 不限）",
          },
          since: {
            type: "string",
            description: "起始日期 YYYY-MM-DD",
          },
          until: {
            type: "string",
            description: "截止日期 YYYY-MM-DD",
          },
          includeReplies: {
            type: "boolean",
            description: "是否包含回复",
          },
          includeRetweets: {
            type: "boolean",
            description: "是否包含转推",
          },
          minLikes: {
            type: "number",
            description: "最低点赞数过滤",
          },
        },
        required: ["username"],
      },
      async execute(_id, params) {
        const b = ensureBot();
        const result = await getProfileTweets(b, params.username, {
          maxPages: params.maxPages || defaultMaxPages,
          maxTweets: params.maxTweets || 0,
          since: params.since,
          until: params.until,
          includeReplies: params.includeReplies || false,
          includeRetweets: params.includeRetweets || false,
          minLikes: params.minLikes || 0,
          logger: {
            log: (m) => api.logger.info(m),
            warn: (m) => api.logger.warn(m),
            error: (m) => api.logger.error(m),
          },
        });
        return jsonResult(result);
      },
    },
    { optional: true },
  );

  // -------------------------------------------------------------------------
  // Tool: x_get_post
  // -------------------------------------------------------------------------

  api.registerTool(
    {
      name: "x_get_post",
      label: "X Search: Get Post Detail",
      description:
        "获取 X.com 推文的完整详情，包括内容、统计、媒体。可选获取对话线程和回复。支持一次获取多条。",
      parameters: {
        type: "object",
        properties: {
          tweetUrl: {
            type: "string",
            description:
              "推文 URL 或 ID（如 https://x.com/user/status/123 或纯数字 ID）。多条用逗号分隔。",
          },
          withThread: {
            type: "boolean",
            description: "是否获取对话线程（上文）",
          },
          withReplies: {
            type: "number",
            description: "获取回复数量（0 = 不获取）",
          },
        },
        required: ["tweetUrl"],
      },
      async execute(_id, params) {
        const b = ensureBot();
        const inputs = params.tweetUrl.split(",").map((s) => s.trim()).filter(Boolean);
        const result = await getPost(b, inputs, {
          withThread: params.withThread || false,
          withReplies: params.withReplies || 0,
          logger: {
            log: (m) => api.logger.info(m),
            warn: (m) => api.logger.warn(m),
            error: (m) => api.logger.error(m),
          },
        });
        return jsonResult(result);
      },
    },
    { optional: true },
  );

  // -------------------------------------------------------------------------
  // Tool: x_get_home_feed
  // -------------------------------------------------------------------------

  api.registerTool(
    {
      name: "x_get_home_feed",
      label: "X Search: Get Home Feed",
      description:
        "获取 X.com 首页推荐流（For You 或 Following）。返回推文列表，支持翻页和过滤。",
      parameters: {
        type: "object",
        properties: {
          feed: {
            type: "string",
            enum: ["foryou", "following"],
            description: "Feed 类型：foryou（推荐）或 following（关注）",
          },
          maxPages: {
            type: "number",
            description: `最多翻页数（默认 ${defaultMaxPages}）`,
          },
          maxTweets: {
            type: "number",
            description: "最多返回推文数（0 = 不限）",
          },
          minLikes: {
            type: "number",
            description: "最低点赞数过滤",
          },
          excludeReplies: {
            type: "boolean",
            description: "排除回复",
          },
          excludeRetweets: {
            type: "boolean",
            description: "排除转推",
          },
        },
      },
      async execute(_id, params) {
        const b = ensureBot();
        const result = await getHomeFeed(b, {
          feed: params.feed || "foryou",
          maxPages: params.maxPages || defaultMaxPages,
          maxTweets: params.maxTweets || 0,
          minLikes: params.minLikes || 0,
          excludeReplies: params.excludeReplies || false,
          excludeRetweets: params.excludeRetweets || false,
          logger: {
            log: (m) => api.logger.info(m),
            warn: (m) => api.logger.warn(m),
            error: (m) => api.logger.error(m),
          },
        });
        return jsonResult(result);
      },
    },
    { optional: true },
  );
}
