#!/usr/bin/env node

/**
 * X.com (Twitter) 帖子内容抓取脚本
 * 使用 GraphQL TweetDetail API 抓取指定推文的完整内容（含对话线程、媒体、视频）
 * 
 * 使用方法:
 *   node scripts/x-post.js <url_or_id> [url_or_id...] [options]
 * 
 * 选项:
 *   --with-thread              抓取完整对话线程（默认只抓取指定推文）
 *   --with-replies <number>    包含回复数，支持分页翻页加载（默认0，不抓取回复）
 *   --pretty                   美化 JSON 输出
 *   --browser-server <url>     JS-Eyes WebSocket 服务器地址（默认 ws://localhost:18080）
 *   --output <file>            指定输出文件路径
 *   --close-tab                抓完后关闭 tab（默认保留供下次复用）
 *   --reply "内容"             对指定推文发表回复（仅支持单条推文）
 *   --reply-style reply|thread  reply=Replying to @xxx 式（默认）；thread=推文下点击回复
 *   --dry-run                  与 --reply 同用时仅打印回复内容，不实际发送
 *   --post "内容"              发一条新帖（无需 URL/ID）；与 --reply、--thread、URL 互斥
 *   --thread "段1" "段2" ...   发串推（第2条起依次回复上一条）；与 --post、--reply、URL 互斥
 *   --thread-delay <ms>        串推每条之间的延迟毫秒（默认 2000）
 *   --thread-max <n>           串推最大条数，超过报错（默认 25）
 * 
 * 文件保存位置:
 *   work_dir/scrape/x_com_post/{tweetId}_{timestamp}/data.json
 *   (多条推文时: work_dir/scrape/x_com_post/batch_{timestamp}/data.json)
 * 
 * 示例:
 *   node scripts/x-post.js https://x.com/elonmusk/status/1234567890
 *   node scripts/x-post.js 1234567890 9876543210 --pretty
 *   node scripts/x-post.js https://x.com/user/status/123 --with-thread
 *   node scripts/x-post.js https://x.com/user/status/123 --with-replies 50
 *   node scripts/x-post.js https://x.com/user/status/123 --with-replies 200 --with-thread
 *   node scripts/x-post.js 1234567890 --output my_post.json --close-tab
 *   node scripts/x-post.js https://x.com/user/status/123 --reply "回复内容"
 *   node scripts/x-post.js https://x.com/user/status/123 --reply "测试" --dry-run
 *   node scripts/x-post.js --post "新帖内容"
 *   node scripts/x-post.js --thread "段1" "段2" "段3" --thread-delay 2000
 * 
 * 注意:
 *   - 需要 JS-Eyes Server 运行中，且浏览器已安装 JS-Eyes 扩展并登录 X.com
 *   - X.com 需要登录状态才能访问 GraphQL API
 *   - 默认不关闭 tab，下次运行可秒级复用已有的 x.com 标签页
 */

const { BrowserAutomation } = require('../lib/js-eyes-client');
const path = require('path');
const fs = require('fs').promises;
const { getPost } = require('../lib/api');
const {
    DEFAULT_GRAPHQL_FEATURES,
    BEARER_TOKEN,
    buildTweetParserSnippet,
    buildGraphQLTweetParserSnippet,
    retryWithBackoff,
    generateTimestamp,
    saveToFile,
    waitForPageLoad,
    createSafeExecuteScript,
    printSummary,
    acquireXTab,
    releaseXTab,
    loadGraphQLCache,
    saveGraphQLCache,
    clearGraphQLCache
} = require('../lib/xUtils');

// ============================================================================
// CLI 参数解析
// ============================================================================

function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        tweetInputs: [],       // URL 或 ID 列表
        withThread: false,
        withReplies: 0,        // 0 = 不抓取回复
        pretty: false,
        browserServer: null,
        output: null,
        closeTab: false,
        reply: null,           // 回复内容，非空时进入回复模式
        dryRun: false,         // 仅打印不发送
        replyStyle: 'reply',   // 'reply' = Replying to @xxx 式回复；'thread' = 点击推文下回复按钮（可能呈 thread）
        post: null,            // 单条新帖正文（--post "内容"）
        thread: [],            // 串推多段（--thread "段1" "段2" ...）
        threadDelay: 3500,     // 串推每条之间延迟毫秒（建议 3～5 秒，避免限流）
        threadMax: 25,         // 串推最大条数
        image: null            // 发帖时附带的图片路径（--image path，仅单条或串推第1条）
    };

    let collectingThread = false;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg.startsWith('--')) {
            collectingThread = false;
            const key = arg.replace('--', '').replace(/-/g, '');
            const nextArg = args[i + 1];

            switch (key) {
                case 'withthread':
                    options.withThread = true;
                    break;
                case 'withreplies':
                    options.withReplies = parseInt(nextArg, 10) || 20;
                    i++;
                    break;
                case 'pretty':
                    options.pretty = true;
                    break;
                case 'browserserver':
                    options.browserServer = nextArg;
                    i++;
                    break;
                case 'output':
                    options.output = nextArg;
                    i++;
                    break;
                case 'closetab':
                    options.closeTab = true;
                    break;
                case 'reply':
                    options.reply = typeof nextArg === 'string' ? nextArg : '';
                    if (options.reply) i++;
                    break;
                case 'dryrun':
                    options.dryRun = true;
                    break;
                case 'replystyle':
                    const style = (nextArg || '').toLowerCase();
                    if (style === 'thread' || style === 'reply') options.replyStyle = style;
                    if (nextArg) i++;
                    break;
                case 'post':
                    options.post = typeof nextArg === 'string' ? nextArg : '';
                    if (options.post) i++;
                    break;
                case 'thread':
                    collectingThread = true;
                    break;
                case 'threaddelay':
                    options.threadDelay = parseInt(nextArg, 10) || 3500;
                    i++;
                    break;
                case 'threadmax':
                    options.threadMax = parseInt(nextArg, 10) || 25;
                    i++;
                    break;
                case 'image':
                    options.image = typeof nextArg === 'string' ? nextArg : '';
                    if (options.image) i++;
                    break;
                default:
                    console.warn(`未知选项: ${arg}`);
            }
        } else {
            if (collectingThread) {
                options.thread.push(arg);
            } else {
                options.tweetInputs.push(arg);
            }
        }
    }

    return options;
}

/**
 * 从输入字符串中提取推文 ID
 * 支持格式:
 *   - 纯数字 ID: 1234567890
 *   - 完整 URL: https://x.com/user/status/1234567890
 *   - 带查询参数的 URL: https://x.com/user/status/1234567890?s=20
 * @param {string} input
 * @returns {string|null} 推文 ID 或 null
 */
function extractTweetId(input) {
    // 纯数字 ID
    if (/^\d+$/.test(input.trim())) {
        return input.trim();
    }
    
    // URL 格式
    const match = input.match(/status\/(\d+)/);
    return match ? match[1] : null;
}

function printUsage() {
    console.log('\n使用方法:');
    console.log('  node scripts/x-post.js <url_or_id> [url_or_id...] [options]');
    console.log('  node scripts/x-post.js --post "内容" [options]');
    console.log('  node scripts/x-post.js --thread "段1" "段2" "段3" [options]');
    console.log('\n选项:');
    console.log('  --with-thread              抓取完整对话线程（默认只抓取指定推文）');
    console.log('  --with-replies <number>    包含回复数，支持分页翻页（默认0，不抓取回复）');
    console.log('  --pretty                   美化 JSON 输出');
    console.log('  --browser-server <url>     浏览器服务器地址');
    console.log('  --output <file>            指定输出文件路径');
    console.log('  --close-tab                抓完后关闭 tab（默认保留）');
    console.log('  --reply "内容"             对指定推文发表回复（回复模式，仅支持单条推文）');
    console.log('  --reply-style <reply|thread>  reply=Replying to @xxx 式（默认）；thread=推文下点击回复（可能呈 thread）');
    console.log('  --dry-run                  与 --reply/--post/--thread 同用时仅打印内容，不实际发送');
    console.log('  --post "内容"             发一条新帖（与 URL、--reply、--thread 互斥）');
    console.log('  --thread "段1" "段2" ...  发串推（与 URL、--post、--reply 互斥）');
    console.log('  --thread-delay <ms>       串推每条之间延迟毫秒（默认 3500，建议 3～5 秒防限流）');
    console.log('  --thread-max <n>          串推最大条数（默认 25）');
    console.log('  --image <path>            发帖时附带图片（仅单条或串推第1条）');
    console.log('\n示例:');
    console.log('  node scripts/x-post.js https://x.com/elonmusk/status/1234567890');
    console.log('  node scripts/x-post.js 1234567890 9876543210 --pretty');
    console.log('  node scripts/x-post.js https://x.com/user/status/123 --with-thread');
    console.log('  node scripts/x-post.js https://x.com/user/status/123 --with-replies 100');
    console.log('  node scripts/x-post.js https://x.com/user/status/123 --reply "回复内容"');
    console.log('  node scripts/x-post.js https://x.com/user/status/123 --reply "回复" --reply-style reply');
    console.log('  node scripts/x-post.js https://x.com/user/status/123 --reply "续推" --reply-style thread');
    console.log('  node scripts/x-post.js https://x.com/user/status/123 --reply "测试" --dry-run');
    console.log('  node scripts/x-post.js --post "新帖内容"');
    console.log('  node scripts/x-post.js --thread "段1" "段2" "段3" --thread-delay 2000');
    console.log('  node scripts/x-post.js --post "带图发帖" --image ./path/to/image.png');
}

// ============================================================================
// GraphQL queryId 发现脚本
// ============================================================================

/**
 * 生成动态发现 TweetDetail 和 TweetResultByRestId queryId 的浏览器端脚本
 * 
 * 发现策略：
 * 1. 从 performance.getEntriesByType('resource') 匹配已有请求
 * 2. 回退到扫描 JS bundle
 */
function buildDiscoverTweetQueryIdsScript() {
    return `
    (async () => {
        try {
            const result = {
                tweetDetailQueryId: null,
                tweetResultByRestIdQueryId: null,
                features: null
            };
            
            // 从 URL 中提取 features
            const parseFeatures = (urlStr) => {
                try {
                    const url = new URL(urlStr);
                    const fp = url.searchParams.get('features');
                    if (fp) return JSON.parse(fp);
                } catch (e) {}
                return null;
            };
            
            // 策略 1: 从 performance API 中匹配
            try {
                const resources = performance.getEntriesByType('resource');
                for (const r of resources) {
                    if (!result.tweetDetailQueryId) {
                        const m = r.name.match(/graphql\\/([A-Za-z0-9_-]+)\\/TweetDetail/);
                        if (m) {
                            result.tweetDetailQueryId = m[1];
                            if (!result.features) result.features = parseFeatures(r.name);
                        }
                    }
                    if (!result.tweetResultByRestIdQueryId) {
                        const m = r.name.match(/graphql\\/([A-Za-z0-9_-]+)\\/TweetResultByRestId/);
                        if (m) {
                            result.tweetResultByRestIdQueryId = m[1];
                            if (!result.features) result.features = parseFeatures(r.name);
                        }
                    }
                }
            } catch (e) {}
            
            // 策略 2: 从 JS bundle 中搜索
            if (!result.tweetDetailQueryId || !result.tweetResultByRestIdQueryId) {
                try {
                    const scripts = document.querySelectorAll('script[src]');
                    const bundleUrls = [];
                    for (const script of scripts) {
                        const src = script.getAttribute('src') || '';
                        if (src.includes('/client-web/') || src.includes('main.')) {
                            bundleUrls.push(src.startsWith('http') ? src : 'https://x.com' + src);
                        }
                    }
                    
                    for (const bundleUrl of bundleUrls.slice(0, 8)) {
                        try {
                            const resp = await fetch(bundleUrl);
                            if (!resp.ok) continue;
                            const text = await resp.text();
                            
                            if (!result.tweetDetailQueryId) {
                                const m = text.match(/queryId:"([A-Za-z0-9_-]+)",operationName:"TweetDetail"/);
                                if (m) result.tweetDetailQueryId = m[1];
                            }
                            if (!result.tweetResultByRestIdQueryId) {
                                const m = text.match(/queryId:"([A-Za-z0-9_-]+)",operationName:"TweetResultByRestId"/);
                                if (m) result.tweetResultByRestIdQueryId = m[1];
                            }
                            
                            if (result.tweetDetailQueryId && result.tweetResultByRestIdQueryId) break;
                        } catch (e) {}
                    }
                } catch (e) {}
            }
            
            return { success: true, ...result };
        } catch (e) {
            return { success: false, error: e.message };
        }
    })();
    `;
}

// ============================================================================
// TweetDetail GraphQL 脚本
// ============================================================================

/**
 * 生成 TweetDetail GraphQL API 调用脚本
 * 返回推文完整内容，包括对话线程和回复
 * 
 * @param {string} tweetId - 推文 ID
 * @param {string} queryId - 动态发现的 queryId
 * @param {Object} [features] - 动态发现的 features
 * @param {boolean} [withThread=false] - 是否包含对话线程
 * @param {boolean} [collectReplies=false] - 是否收集回复
 * @returns {string} JS 代码字符串
 */
function buildTweetDetailScript(tweetId, queryId, features, withThread = false, collectReplies = false) {
    const featuresToUse = features || DEFAULT_GRAPHQL_FEATURES;
    const featuresLiteral = JSON.stringify(featuresToUse);
    
    return `
    (async () => {
        try {
            const ct0 = document.cookie.match(/ct0=([^;]+)/)?.[1];
            if (!ct0) {
                return { success: false, error: '未找到 ct0 cookie，请确保已登录 X.com' };
            }
            
            const variables = {
                focalTweetId: '${tweetId}',
                with_rux_injections: false,
                rankingMode: 'Relevance',
                includePromotedContent: false,
                withCommunity: true,
                withQuickPromoteEligibilityTweetFields: true,
                withBirdwatchNotes: true,
                withVoice: true,
                withV2Timeline: true
            };
            
            const features = ${featuresLiteral};
            
            const fieldToggles = {
                withArticleRichContentState: true,
                withArticlePlainText: false,
                withGrokAnalyze: false,
                withDisallowedReplyControls: false
            };
            
            const apiUrl = 'https://x.com/i/api/graphql/${queryId}/TweetDetail?' +
                'variables=' + encodeURIComponent(JSON.stringify(variables)) +
                '&features=' + encodeURIComponent(JSON.stringify(features)) +
                '&fieldToggles=' + encodeURIComponent(JSON.stringify(fieldToggles));
            
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);
            
            let response;
            try {
                response = await fetch(apiUrl, {
                    signal: controller.signal,
                    credentials: 'include',
                    headers: {
                        'authorization': '${BEARER_TOKEN}',
                        'x-csrf-token': ct0,
                        'x-twitter-auth-type': 'OAuth2Session',
                        'x-twitter-active-user': 'yes',
                        'content-type': 'application/json'
                    }
                });
                clearTimeout(timeoutId);
            } catch (fetchError) {
                clearTimeout(timeoutId);
                if (fetchError.name === 'AbortError') {
                    return { success: false, error: 'GraphQL 请求超时' };
                }
                return { success: false, error: fetchError.message };
            }
            
            if (!response.ok) {
                const retryAfter = response.headers.get('retry-after') || null;
                let errorDetail = '';
                try { errorDetail = await response.text(); errorDetail = errorDetail.substring(0, 300); } catch(e) {}
                return { 
                    success: false, 
                    error: 'HTTP ' + response.status + (errorDetail ? ': ' + errorDetail : ''),
                    statusCode: response.status,
                    retryAfter: retryAfter ? parseInt(retryAfter, 10) : null
                };
            }
            
            const data = await response.json();
            
            try {
                const instructions = data?.data?.threaded_conversation_with_injections_v2?.instructions || [];
                
                let allEntries = [];
                for (const instruction of instructions) {
                    if (instruction.type === 'TimelineAddEntries' && instruction.entries) {
                        allEntries = allEntries.concat(instruction.entries);
                    }
                }
                
                ${buildParseTweetResultSnippet()}
                
                // 解析 focal tweet（主推文）
                let focalTweet = null;
                const threadTweets = [];
                const replies = [];
                let replyCursor = null;
                
                // 遍历所有 entries，分类为线程/focal/回复
                for (const entry of allEntries) {
                    const entryId = entry.entryId || '';
                    
                    // 提取回复分页游标
                    if (entryId.startsWith('cursor-bottom-')) {
                        replyCursor = entry.content?.itemContent?.value 
                            || entry.content?.value || null;
                        continue;
                    }
                    if (entryId.startsWith('cursor-')) continue;
                    
                    // 单条推文 entry
                    if (entryId.startsWith('tweet-')) {
                        const tweetResult = entry.content?.itemContent?.tweet_results?.result;
                        if (!tweetResult) continue;
                        
                        const parsed = parseTweetResult(tweetResult);
                        if (!parsed) continue;
                        
                        if (parsed.tweetId === '${tweetId}') {
                            focalTweet = parsed;
                        } else if (!focalTweet) {
                            threadTweets.push(parsed);
                        } else {
                            replies.push(parsed);
                        }
                        continue;
                    }
                    
                    // 对话模块（conversationthread-）包含多条推文
                    if (entryId.startsWith('conversationthread-')) {
                        const items = entry.content?.items || [];
                        for (const item of items) {
                            const tweetResult = item.item?.itemContent?.tweet_results?.result;
                            if (!tweetResult) continue;
                            
                            const parsed = parseTweetResult(tweetResult);
                            if (!parsed) continue;
                            
                            if (parsed.tweetId === '${tweetId}') {
                                focalTweet = parsed;
                            } else if (!focalTweet) {
                                threadTweets.push(parsed);
                            } else {
                                replies.push(parsed);
                            }
                        }
                    }
                }
                
                if (!focalTweet) {
                    return { success: false, error: '未找到目标推文，可能已删除或不可见' };
                }
                
                const result = {
                    success: true,
                    focalTweet: focalTweet,
                    replyCursor: replyCursor
                };
                
                if (${withThread ? 'true' : 'false'}) {
                    result.threadTweets = threadTweets;
                }
                
                if (${collectReplies ? 'true' : 'false'}) {
                    result.replies = replies;
                }
                
                return result;
            } catch (parseError) {
                return { success: false, error: '解析响应失败: ' + parseError.message, raw: JSON.stringify(data).substring(0, 500) };
            }
        } catch (e) {
            return { success: false, error: e.message };
        }
    })();
    `;
}

// ============================================================================
// TweetDetail 回复分页脚本
// ============================================================================

/**
 * 生成 TweetDetail 回复分页 GraphQL API 调用脚本
 * 使用 cursor 加载更多回复
 * 
 * @param {string} tweetId - 推文 ID
 * @param {string} cursor - 分页游标
 * @param {string} queryId - 动态发现的 queryId
 * @param {Object} [features] - 动态发现的 features
 * @returns {string} JS 代码字符串
 */
function buildTweetDetailCursorScript(tweetId, cursor, queryId, features) {
    const featuresToUse = features || DEFAULT_GRAPHQL_FEATURES;
    const featuresLiteral = JSON.stringify(featuresToUse);
    const safeCursor = (cursor || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
    
    return `
    (async () => {
        try {
            const ct0 = document.cookie.match(/ct0=([^;]+)/)?.[1];
            if (!ct0) {
                return { success: false, error: '未找到 ct0 cookie，请确保已登录 X.com' };
            }
            
            const variables = {
                focalTweetId: '${tweetId}',
                cursor: '${safeCursor}',
                referrer: 'tweet',
                with_rux_injections: false,
                rankingMode: 'Relevance',
                includePromotedContent: false,
                withCommunity: true,
                withQuickPromoteEligibilityTweetFields: true,
                withBirdwatchNotes: true,
                withVoice: true,
                withV2Timeline: true
            };
            
            const features = ${featuresLiteral};
            
            const fieldToggles = {
                withArticleRichContentState: true,
                withArticlePlainText: false,
                withGrokAnalyze: false,
                withDisallowedReplyControls: false
            };
            
            const apiUrl = 'https://x.com/i/api/graphql/${queryId}/TweetDetail?' +
                'variables=' + encodeURIComponent(JSON.stringify(variables)) +
                '&features=' + encodeURIComponent(JSON.stringify(features)) +
                '&fieldToggles=' + encodeURIComponent(JSON.stringify(fieldToggles));
            
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);
            
            let response;
            try {
                response = await fetch(apiUrl, {
                    signal: controller.signal,
                    credentials: 'include',
                    headers: {
                        'authorization': '${BEARER_TOKEN}',
                        'x-csrf-token': ct0,
                        'x-twitter-auth-type': 'OAuth2Session',
                        'x-twitter-active-user': 'yes',
                        'content-type': 'application/json'
                    }
                });
                clearTimeout(timeoutId);
            } catch (fetchError) {
                clearTimeout(timeoutId);
                if (fetchError.name === 'AbortError') {
                    return { success: false, error: 'GraphQL 请求超时' };
                }
                return { success: false, error: fetchError.message };
            }
            
            if (!response.ok) {
                const retryAfter = response.headers.get('retry-after') || null;
                let errorDetail = '';
                try { errorDetail = await response.text(); errorDetail = errorDetail.substring(0, 300); } catch(e) {}
                return { 
                    success: false, 
                    error: 'HTTP ' + response.status + (errorDetail ? ': ' + errorDetail : ''),
                    statusCode: response.status,
                    retryAfter: retryAfter ? parseInt(retryAfter, 10) : null
                };
            }
            
            const data = await response.json();
            
            try {
                const instructions = data?.data?.threaded_conversation_with_injections_v2?.instructions || [];
                
                let allEntries = [];
                for (const instruction of instructions) {
                    if (instruction.type === 'TimelineAddEntries' && instruction.entries) {
                        allEntries = allEntries.concat(instruction.entries);
                    }
                    // TimelineAddToModule 可能包含嵌套的回复
                    if (instruction.type === 'TimelineAddToModule' && instruction.moduleItems) {
                        for (const moduleItem of instruction.moduleItems) {
                            if (moduleItem.item?.itemContent?.tweet_results?.result) {
                                allEntries.push({
                                    entryId: 'moduletweet-' + (moduleItem.item?.itemContent?.tweet_results?.result?.rest_id || ''),
                                    content: { itemContent: moduleItem.item.itemContent }
                                });
                            }
                        }
                    }
                }
                
                ${buildParseTweetResultSnippet()}
                
                const replies = [];
                let nextCursor = null;
                
                for (const entry of allEntries) {
                    const entryId = entry.entryId || '';
                    
                    // 提取下一页游标
                    if (entryId.startsWith('cursor-bottom-')) {
                        nextCursor = entry.content?.itemContent?.value 
                            || entry.content?.value || null;
                        continue;
                    }
                    if (entryId.startsWith('cursor-')) continue;
                    
                    // 单条推文
                    if (entryId.startsWith('tweet-') || entryId.startsWith('moduletweet-')) {
                        const tweetResult = entry.content?.itemContent?.tweet_results?.result;
                        if (!tweetResult) continue;
                        
                        const parsed = parseTweetResult(tweetResult);
                        if (parsed && parsed.tweetId !== '${tweetId}') {
                            replies.push(parsed);
                        }
                        continue;
                    }
                    
                    // 对话模块
                    if (entryId.startsWith('conversationthread-')) {
                        const items = entry.content?.items || [];
                        for (const item of items) {
                            const tweetResult = item.item?.itemContent?.tweet_results?.result;
                            if (!tweetResult) continue;
                            
                            const parsed = parseTweetResult(tweetResult);
                            if (parsed && parsed.tweetId !== '${tweetId}') {
                                replies.push(parsed);
                            }
                        }
                    }
                }
                
                return {
                    success: true,
                    replies: replies,
                    nextCursor: nextCursor
                };
            } catch (parseError) {
                return { success: false, error: '解析回复分页失败: ' + parseError.message };
            }
        } catch (e) {
            return { success: false, error: e.message };
        }
    })();
    `;
}

// ============================================================================
// 共享的推文解析代码片段（浏览器端）
// ============================================================================

/**
 * 生成浏览器端共享的 parseTweetResult 函数代码片段
 * 供 buildTweetDetailScript 和 buildTweetDetailCursorScript 共用
 */
function buildParseTweetResultSnippet() {
    return `
                // 递归解析 tweet result
                const parseTweetResult = (tweetResult) => {
                    if (!tweetResult) return null;
                    const actualTweet = tweetResult.tweet || tweetResult;
                    const legacy = actualTweet.legacy;
                    if (!legacy) return null;
                    
                    // 跳过广告
                    if (actualTweet.promotedMetadata) return null;
                    
                    const userResult = actualTweet.core?.user_results?.result;
                    const userLegacy = userResult?.legacy;
                    const userCore = userResult?.core;
                    const userAvatar = userResult?.avatar;
                    
                    // 提取媒体 URL（增强版：包含视频多质量等级）
                    const mediaUrls = [];
                    const mediaDetails = [];
                    const mediaEntities = legacy.extended_entities?.media || legacy.entities?.media || [];
                    
                    mediaEntities.forEach(media => {
                        if (media.type === 'photo' && media.media_url_https) {
                            mediaUrls.push(media.media_url_https);
                            mediaDetails.push({
                                type: 'photo',
                                url: media.media_url_https,
                                expandedUrl: media.expanded_url || '',
                                width: media.original_info?.width || 0,
                                height: media.original_info?.height || 0
                            });
                        } else if (media.type === 'video' || media.type === 'animated_gif') {
                            const variants = (media.video_info?.variants || [])
                                .filter(v => v.content_type === 'video/mp4')
                                .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
                            
                            const bestMp4 = variants[0];
                            if (bestMp4) {
                                mediaUrls.push(bestMp4.url);
                            }
                            
                            const m3u8 = (media.video_info?.variants || [])
                                .find(v => v.content_type === 'application/x-mpegURL');
                            
                            mediaDetails.push({
                                type: media.type,
                                posterUrl: media.media_url_https || '',
                                duration: media.video_info?.duration_millis || 0,
                                variants: (media.video_info?.variants || []).map(v => ({
                                    url: v.url,
                                    contentType: v.content_type,
                                    bitrate: v.bitrate || 0
                                })),
                                bestMp4Url: bestMp4?.url || '',
                                m3u8Url: m3u8?.url || '',
                                width: media.original_info?.width || 0,
                                height: media.original_info?.height || 0
                            });
                        }
                    });
                    
                    // 提取引用推文
                    let quoteTweet = null;
                    const quotedResult = legacy.quoted_status_result?.result 
                        || actualTweet.quoted_status_result?.result;
                    if (quotedResult) {
                        quoteTweet = parseTweetResult(quotedResult);
                    }
                    
                    // 提取卡片（链接预览）
                    let card = null;
                    const cardData = actualTweet.card?.legacy;
                    if (cardData) {
                        const bindingValues = {};
                        (cardData.binding_values || []).forEach(bv => {
                            const val = bv.value?.string_value || bv.value?.image_value?.url || '';
                            if (val) bindingValues[bv.key] = val;
                        });
                        card = {
                            name: cardData.name || '',
                            title: bindingValues.title || '',
                            description: bindingValues.description || '',
                            url: bindingValues.card_url || bindingValues.url || '',
                            thumbnailUrl: bindingValues.thumbnail_image_original || bindingValues.thumbnail_image || '',
                            domain: bindingValues.domain || bindingValues.vanity_url || ''
                        };
                    }
                    
                    // 提取 note_tweet（长推文完整内容）
                    const noteText = actualTweet.note_tweet?.note_tweet_results?.result?.text || '';
                    
                    const screenName = userCore?.screen_name || userLegacy?.screen_name || '';
                    const tweetIdStr = legacy.id_str || actualTweet.rest_id || '';
                    
                    return {
                        tweetId: tweetIdStr,
                        author: {
                            name: userCore?.name || userLegacy?.name || '',
                            username: '@' + screenName,
                            avatarUrl: userAvatar?.image_url || userLegacy?.profile_image_url_https || '',
                            isVerified: userResult?.is_blue_verified || false
                        },
                        content: noteText || legacy.full_text || '',
                        publishTime: legacy.created_at || '',
                        lang: legacy.lang || '',
                        stats: {
                            replies: legacy.reply_count || 0,
                            retweets: legacy.retweet_count || 0,
                            likes: legacy.favorite_count || 0,
                            views: parseInt(actualTweet.views?.count, 10) || 0,
                            bookmarks: legacy.bookmark_count || 0,
                            quotes: legacy.quote_count || 0
                        },
                        mediaUrls: [...new Set(mediaUrls)],
                        mediaDetails: mediaDetails,
                        tweetUrl: screenName && tweetIdStr ? ('https://x.com/' + screenName + '/status/' + tweetIdStr) : '',
                        isRetweet: !!legacy.retweeted_status_result,
                        isReply: !!legacy.in_reply_to_status_id_str,
                        inReplyToTweetId: legacy.in_reply_to_status_id_str || null,
                        inReplyToUser: legacy.in_reply_to_screen_name || null,
                        conversationId: legacy.conversation_id_str || '',
                        quoteTweet: quoteTweet,
                        card: card,
                        source: actualTweet.source || ''
                    };
                };
    `;
}

// ============================================================================
// TweetResultByRestId 回退脚本
// ============================================================================

/**
 * 生成 TweetResultByRestId GraphQL API 调用脚本（简化版回退）
 * 当 TweetDetail queryId 不可用时使用
 * 
 * @param {string} tweetId - 推文 ID
 * @param {string} queryId - 动态发现的 queryId
 * @param {Object} [features] - 动态发现的 features
 * @returns {string} JS 代码字符串
 */
function buildTweetByRestIdScript(tweetId, queryId, features) {
    const featuresToUse = features || DEFAULT_GRAPHQL_FEATURES;
    const featuresLiteral = JSON.stringify(featuresToUse);
    
    return `
    (async () => {
        try {
            const ct0 = document.cookie.match(/ct0=([^;]+)/)?.[1];
            if (!ct0) {
                return { success: false, error: '未找到 ct0 cookie，请确保已登录 X.com' };
            }
            
            const variables = {
                tweetId: '${tweetId}',
                withCommunity: true,
                includePromotedContent: false,
                withVoice: true
            };
            
            const features = ${featuresLiteral};
            
            const apiUrl = 'https://x.com/i/api/graphql/${queryId}/TweetResultByRestId?' +
                'variables=' + encodeURIComponent(JSON.stringify(variables)) +
                '&features=' + encodeURIComponent(JSON.stringify(features));
            
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);
            
            let response;
            try {
                response = await fetch(apiUrl, {
                    signal: controller.signal,
                    credentials: 'include',
                    headers: {
                        'authorization': '${BEARER_TOKEN}',
                        'x-csrf-token': ct0,
                        'x-twitter-auth-type': 'OAuth2Session',
                        'x-twitter-active-user': 'yes',
                        'content-type': 'application/json'
                    }
                });
                clearTimeout(timeoutId);
            } catch (fetchError) {
                clearTimeout(timeoutId);
                if (fetchError.name === 'AbortError') {
                    return { success: false, error: 'GraphQL 请求超时' };
                }
                return { success: false, error: fetchError.message };
            }
            
            if (!response.ok) {
                const retryAfter = response.headers.get('retry-after') || null;
                let errorDetail = '';
                try { errorDetail = await response.text(); errorDetail = errorDetail.substring(0, 300); } catch(e) {}
                return { 
                    success: false, 
                    error: 'HTTP ' + response.status + (errorDetail ? ': ' + errorDetail : ''),
                    statusCode: response.status,
                    retryAfter: retryAfter ? parseInt(retryAfter, 10) : null
                };
            }
            
            const data = await response.json();
            
            try {
                const tweetResult = data?.data?.tweetResult?.result;
                if (!tweetResult) {
                    return { success: false, error: '推文不存在或已删除' };
                }
                
                const actualTweet = tweetResult.tweet || tweetResult;
                const legacy = actualTweet.legacy;
                if (!legacy) {
                    return { success: false, error: '推文数据结构异常' };
                }
                
                const userResult = actualTweet.core?.user_results?.result;
                const userLegacy = userResult?.legacy;
                const userCore = userResult?.core;
                const userAvatar = userResult?.avatar;
                
                // 提取媒体
                const mediaUrls = [];
                const mediaDetails = [];
                const mediaEntities = legacy.extended_entities?.media || legacy.entities?.media || [];
                
                mediaEntities.forEach(media => {
                    if (media.type === 'photo' && media.media_url_https) {
                        mediaUrls.push(media.media_url_https);
                        mediaDetails.push({
                            type: 'photo',
                            url: media.media_url_https,
                            expandedUrl: media.expanded_url || '',
                            width: media.original_info?.width || 0,
                            height: media.original_info?.height || 0
                        });
                    } else if (media.type === 'video' || media.type === 'animated_gif') {
                        const variants = (media.video_info?.variants || [])
                            .filter(v => v.content_type === 'video/mp4')
                            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
                        
                        const bestMp4 = variants[0];
                        if (bestMp4) {
                            mediaUrls.push(bestMp4.url);
                        }
                        
                        const m3u8 = (media.video_info?.variants || [])
                            .find(v => v.content_type === 'application/x-mpegURL');
                        
                        mediaDetails.push({
                            type: media.type,
                            posterUrl: media.media_url_https || '',
                            duration: media.video_info?.duration_millis || 0,
                            variants: (media.video_info?.variants || []).map(v => ({
                                url: v.url,
                                contentType: v.content_type,
                                bitrate: v.bitrate || 0
                            })),
                            bestMp4Url: bestMp4?.url || '',
                            m3u8Url: m3u8?.url || '',
                            width: media.original_info?.width || 0,
                            height: media.original_info?.height || 0
                        });
                    }
                });
                
                // 提取引用推文
                let quoteTweet = null;
                const quotedResult = legacy.quoted_status_result?.result 
                    || actualTweet.quoted_status_result?.result;
                if (quotedResult) {
                    const qt = quotedResult.tweet || quotedResult;
                    const qtLegacy = qt.legacy;
                    if (qtLegacy) {
                        const qtUser = qt.core?.user_results?.result;
                        const qtUserLegacy = qtUser?.legacy;
                        const qtUserCore = qtUser?.core;
                        const qtScreenName = qtUserCore?.screen_name || qtUserLegacy?.screen_name || '';
                        quoteTweet = {
                            tweetId: qtLegacy.id_str || qt.rest_id || '',
                            author: {
                                name: qtUserCore?.name || qtUserLegacy?.name || '',
                                username: '@' + qtScreenName,
                            },
                            content: qtLegacy.full_text || '',
                            publishTime: qtLegacy.created_at || '',
                            tweetUrl: qtScreenName ? ('https://x.com/' + qtScreenName + '/status/' + (qtLegacy.id_str || qt.rest_id)) : ''
                        };
                    }
                }
                
                // 提取卡片
                let card = null;
                const cardData = actualTweet.card?.legacy;
                if (cardData) {
                    const bindingValues = {};
                    (cardData.binding_values || []).forEach(bv => {
                        const val = bv.value?.string_value || bv.value?.image_value?.url || '';
                        if (val) bindingValues[bv.key] = val;
                    });
                    card = {
                        name: cardData.name || '',
                        title: bindingValues.title || '',
                        description: bindingValues.description || '',
                        url: bindingValues.card_url || bindingValues.url || '',
                        thumbnailUrl: bindingValues.thumbnail_image_original || bindingValues.thumbnail_image || '',
                        domain: bindingValues.domain || bindingValues.vanity_url || ''
                    };
                }
                
                const noteText = actualTweet.note_tweet?.note_tweet_results?.result?.text || '';
                const screenName = userCore?.screen_name || userLegacy?.screen_name || '';
                const tweetIdStr = legacy.id_str || actualTweet.rest_id || '';
                
                return {
                    success: true,
                    focalTweet: {
                        tweetId: tweetIdStr,
                        author: {
                            name: userCore?.name || userLegacy?.name || '',
                            username: '@' + screenName,
                            avatarUrl: userAvatar?.image_url || userLegacy?.profile_image_url_https || '',
                            isVerified: userResult?.is_blue_verified || false
                        },
                        content: noteText || legacy.full_text || '',
                        publishTime: legacy.created_at || '',
                        lang: legacy.lang || '',
                        stats: {
                            replies: legacy.reply_count || 0,
                            retweets: legacy.retweet_count || 0,
                            likes: legacy.favorite_count || 0,
                            views: parseInt(actualTweet.views?.count, 10) || 0,
                            bookmarks: legacy.bookmark_count || 0,
                            quotes: legacy.quote_count || 0
                        },
                        mediaUrls: [...new Set(mediaUrls)],
                        mediaDetails: mediaDetails,
                        tweetUrl: screenName && tweetIdStr ? ('https://x.com/' + screenName + '/status/' + tweetIdStr) : '',
                        isRetweet: !!legacy.retweeted_status_result,
                        isReply: !!legacy.in_reply_to_status_id_str,
                        inReplyToTweetId: legacy.in_reply_to_status_id_str || null,
                        inReplyToUser: legacy.in_reply_to_screen_name || null,
                        conversationId: legacy.conversation_id_str || '',
                        quoteTweet: quoteTweet,
                        card: card,
                        source: actualTweet.source || ''
                    }
                };
            } catch (parseError) {
                return { success: false, error: '解析响应失败: ' + parseError.message };
            }
        } catch (e) {
            return { success: false, error: e.message };
        }
    })();
    `;
}

// ============================================================================
// DOM 回退脚本
// ============================================================================

/**
 * 生成帖子详情页 DOM 提取脚本（回退方案）
 * 在推文详情页直接从 DOM 中提取内容
 * 
 * @param {string} tweetId - 推文 ID
 */
function buildPostDomScript(tweetId) {
    return `
    (async () => {
        try {
            const delay = ms => new Promise(r => setTimeout(r, ms));
            
            ${buildTweetParserSnippet()}
            
            // 等待推文出现
            let contentReady = false;
            for (let i = 0; i < 15; i++) {
                const count = document.querySelectorAll('article[data-testid="tweet"]').length;
                if (count > 0) {
                    contentReady = true;
                    break;
                }
                await delay(1000);
            }
            
            if (!contentReady) {
                return { success: false, error: '未检测到推文内容，可能已删除或页面加载异常' };
            }
            
            // 在详情页中，主推文通常是第一个 article（如果是线程则可能有多个）
            const articles = document.querySelectorAll('article[data-testid="tweet"]');
            let focalTweet = null;
            const threadTweets = [];
            
            for (const article of articles) {
                try {
                    const tweet = parseTweetArticle(article);
                    if (!tweet) continue;
                    
                    if (tweet.tweetId === '${tweetId}') {
                        focalTweet = tweet;
                    } else if (!focalTweet) {
                        // focal tweet 之前的是线程上文
                        threadTweets.push(tweet);
                    }
                } catch (e) { /* skip */ }
            }
            
            if (!focalTweet && articles.length > 0) {
                // 如果没有精确匹配到 ID，取第一个非回复的推文
                try {
                    focalTweet = parseTweetArticle(articles[0]);
                } catch (e) {}
            }
            
            if (!focalTweet) {
                return { success: false, error: 'DOM 中未找到目标推文' };
            }
            
            return { 
                success: true, 
                focalTweet: focalTweet,
                threadTweets: threadTweets
            };
        } catch (e) {
            return { success: false, error: e.message };
        }
    })();
    `;
}

// ============================================================================
// 回复：DOM 方案
// ============================================================================

/**
 * 生成通过 DOM 发表回复的浏览器端脚本
 * 定位目标推文的回复按钮，点击后填写 composer 并点击发送
 *
 * @param {string} tweetId - 被回复的推文 ID
 * @param {string} replyText - 回复正文
 * @returns {string} 可在浏览器中执行的 IIFE 脚本
 */
function buildReplyViaDomScript(tweetId, replyText) {
    const safeReplyText = JSON.stringify(replyText || '');
    const safeTweetId = String(tweetId).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `
    (async () => {
        const delay = ms => new Promise(r => setTimeout(r, ms));
        const replyText = ${safeReplyText};
        const targetTweetId = '${safeTweetId}';
        try {
            var articles = document.querySelectorAll('article[data-testid="tweet"]');
            let targetArticle = null;
            for (var artIdx = 0; artIdx < articles.length; artIdx++) {
                var art = articles[artIdx];
                const link = art.querySelector('a[href*="/status/' + targetTweetId + '"]');
                if (link) {
                    targetArticle = art;
                    break;
                }
            }
            if (!targetArticle) targetArticle = articles[0];
            if (!targetArticle) {
                return { success: false, error: '未找到推文区域' };
            }
            const replyBtn = targetArticle.querySelector('[data-testid="reply"]');
            if (!replyBtn) {
                return { success: false, error: '未找到回复按钮' };
            }
            replyBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
            await delay(300);
            replyBtn.click();
            await delay(1500);
            var composerRoot = document.querySelector('[role="dialog"]') || document.querySelector('[data-testid="tweetComposer"]') || document.body;
            var isVisible = function(el) {
                if (!el || !el.getBoundingClientRect) return false;
                var r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && r.top < window.innerHeight && r.bottom > 0;
            };
            let textarea = null;
            for (var round = 0; round < 25; round++) {
                var candidates = composerRoot.querySelectorAll('[data-testid="tweetTextarea_0"], [role="textbox"][contenteditable="true"], [contenteditable="true"]');
                for (var k = 0; k < candidates.length; k++) {
                    if (isVisible(candidates[k])) {
                        textarea = candidates[k];
                        break;
                    }
                }
                if (textarea) break;
                await delay(350);
            }
            if (!textarea) {
                return { success: false, error: '未找到可见的回复输入框（等待超时）' };
            }
            textarea.scrollIntoView({ behavior: 'instant', block: 'center' });
            await delay(250);
            textarea.click();
            await delay(200);
            textarea.focus();
            await delay(200);
            if (textarea.contentEditable === 'true') {
                textarea.focus();
                for (var ci = 0; ci < replyText.length; ci++) {
                    var ch = replyText[ci];
                    if (document.execCommand) {
                        document.execCommand('insertText', false, ch);
                    } else {
                        var sel = window.getSelection();
                        var range = document.createRange();
                        textarea.focus();
                        if (textarea.childNodes.length) {
                            range.setStart(textarea.childNodes[0], (textarea.textContent || '').length);
                        } else {
                            range.setStart(textarea, 0);
                        }
                        range.collapse(true);
                        sel.removeAllRanges();
                        sel.addRange(range);
                        textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
                        textarea.textContent = (textarea.textContent || '') + ch;
                    }
                    await delay(25);
                }
                textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: replyText }));
            } else {
                textarea.value = replyText;
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
            }
            await delay(1200);
            textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: replyText }));
            await delay(800);
            var root = composerRoot && composerRoot !== document.body ? composerRoot : document;
            let postBtn = null;
            for (var waitRound = 0; waitRound < 25; waitRound++) {
                postBtn = root.querySelector('[data-testid="tweetButtonInline"]');
                if (!postBtn) postBtn = root.querySelector('[data-testid="tweetButton"]');
                if (!postBtn) {
                    postBtn = Array.from(root.querySelectorAll('button[role="button"]')).find(function(b) {
                        if (!isVisible(b)) return false;
                        var t = (b.textContent || '').trim();
                        return (t === 'Post' || t === 'Reply' || t === '发推' || t === '回复');
                    });
                }
                if (postBtn && !postBtn.hasAttribute('disabled') && !postBtn.disabled && postBtn.getAttribute('aria-disabled') !== 'true') {
                    break;
                }
                postBtn = null;
                await delay(400);
            }
            if (!postBtn) {
                return { success: false, error: '未找到发送按钮' };
            }
            if (postBtn.hasAttribute('disabled') || postBtn.disabled || postBtn.getAttribute('aria-disabled') === 'true') {
                return { success: false, error: '发送按钮不可用（等待超时，可能未满足字数或权限）' };
            }
            postBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
            await delay(300);
            postBtn.click();
            await delay(2500);
            var newReplyId = null;
            try {
                var articles = document.querySelectorAll('article[data-testid="tweet"]');
                var focalIndex = -1;
                for (var j = 0; j < articles.length; j++) {
                    var linkInArt = articles[j].querySelector('a[href*="/status/' + targetTweetId + '"]');
                    if (linkInArt) {
                        focalIndex = j;
                        break;
                    }
                }
                var replyArticle = focalIndex >= 0 && focalIndex + 1 < articles.length ? articles[focalIndex + 1] : articles[0];
                var replyLink = replyArticle ? replyArticle.querySelector('a[href*="/status/"]') : null;
                if (replyLink && replyLink.href) {
                    var m = replyLink.href.match(/status\\/(\\d+)/);
                    if (m) newReplyId = m[1];
                }
            } catch (e) {}
            return { success: true, tweetId: newReplyId || undefined };
        } catch (e) {
            return { success: false, error: e.message };
        }
    })();
    `;
}

/**
 * 生成在 intent 页面 (x.com/intent/tweet?in_reply_to=xxx) 填写并发送的脚本
 * 该页面会打开「Replying to @xxx」式回复框，不会形成 thread
 *
 * @param {string} replyText - 回复正文
 * @returns {string} 可在浏览器中执行的 IIFE 脚本
 */
function buildReplyViaIntentScript(replyText) {
    const safeReplyText = JSON.stringify(replyText || '');
    return `
    (async () => {
        const delay = ms => new Promise(r => setTimeout(r, ms));
        const replyText = ${safeReplyText};
        try {
            await delay(3500);
            var composerRoot = document.querySelector('[role="dialog"]') || document.querySelector('[data-testid="tweetComposer"]') || document.body;
            var isVisible = function(el) {
                if (!el || !el.getBoundingClientRect) return false;
                var r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && r.top < window.innerHeight && r.bottom > 0;
            };
            let textarea = null;
            for (var round = 0; round < 35; round++) {
                var candidates = composerRoot.querySelectorAll('[data-testid="tweetTextarea_0"], [role="textbox"][contenteditable="true"], [contenteditable="true"]');
                for (var k = 0; k < candidates.length; k++) {
                    if (isVisible(candidates[k])) {
                        textarea = candidates[k];
                        break;
                    }
                }
                if (textarea) break;
                await delay(400);
            }
            if (!textarea) {
                return { success: false, error: '未找到可见的输入框（intent 页等待超时）' };
            }
            textarea.scrollIntoView({ behavior: 'instant', block: 'center' });
            await delay(300);
            textarea.click();
            await delay(250);
            textarea.focus();
            await delay(250);
            if (textarea.contentEditable === 'true') {
                for (var ci = 0; ci < replyText.length; ci++) {
                    var ch = replyText[ci];
                    if (document.execCommand) {
                        document.execCommand('insertText', false, ch);
                    } else {
                        textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
                        textarea.textContent = (textarea.textContent || '') + ch;
                    }
                    await delay(30);
                }
                textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: replyText }));
            } else {
                textarea.value = replyText;
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
            }
            await delay(1200);
            var root = composerRoot && composerRoot !== document.body ? composerRoot : document;
            let postBtn = root.querySelector('[data-testid="tweetButtonInline"]');
            if (!postBtn) postBtn = root.querySelector('[data-testid="tweetButton"]');
            if (!postBtn) {
                postBtn = Array.from(root.querySelectorAll('button[role="button"]')).find(function(b) {
                    var t = (b.textContent || '').trim();
                    return (t === 'Post' || t === 'Reply' || t === '发推' || t === '回复') && !b.disabled && !b.hasAttribute('disabled');
                });
            }
            if (!postBtn) {
                return { success: false, error: '未找到发送按钮' };
            }
            if (postBtn.hasAttribute('disabled') || postBtn.getAttribute('aria-disabled') === 'true' || postBtn.disabled) {
                return { success: false, error: '发送按钮不可用（可能内容未正确填入）' };
            }
            postBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
            await delay(200);
            postBtn.click();
            await delay(2500);
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    })();
    `;
}

/**
 * 在 intent 页面执行回复（Replying to @xxx 式）
 */
async function postReplyViaIntent(browser, tabId, replyText, safeExecuteScript) {
    const script = buildReplyViaIntentScript(replyText);
    const result = await safeExecuteScript(tabId, script, { timeout: 20000 });
    return result || { success: false, error: '脚本未返回结果' };
}

/**
 * 通过 DOM 对指定推文发表回复
 *
 * @param {object} browser - BrowserAutomation 实例
 * @param {string} tabId - 标签页 ID
 * @param {string} tweetId - 被回复的推文 ID
 * @param {string} replyText - 回复正文
 * @param {function} safeExecuteScript - createSafeExecuteScript(browser) 返回的函数
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function postReplyViaDom(browser, tabId, tweetId, replyText, safeExecuteScript) {
    const script = buildReplyViaDomScript(tweetId, replyText);
    const result = await safeExecuteScript(tabId, script, { timeout: 15000 });
    return result || { success: false, error: '脚本未返回结果' };
}

// ============================================================================
// 回复：GraphQL Mutation 方案（可选优先）
// ============================================================================

/**
 * 生成动态发现 CreateTweet mutation queryId 的浏览器端脚本
 * 从 performance 或 JS bundle 中查找 CreateTweet operation 的 queryId
 */
function buildDiscoverCreateTweetQueryIdScript() {
    return `
    (async () => {
        try {
            let createTweetQueryId = null;
            let features = null;
            const parseFeatures = (urlStr) => {
                try {
                    const url = new URL(urlStr);
                    const fp = url.searchParams.get('features');
                    if (fp) return JSON.parse(fp);
                } catch (e) {}
                return null;
            };
            try {
                const resources = performance.getEntriesByType('resource');
                for (const r of resources) {
                    const m = r.name.match(/graphql\\/([A-Za-z0-9_-]+)\\/CreateTweet/);
                    if (m) {
                        createTweetQueryId = m[1];
                        features = features || parseFeatures(r.name);
                        break;
                    }
                }
            } catch (e) {}
            if (!createTweetQueryId) {
                try {
                    const scripts = document.querySelectorAll('script[src]');
                    const bundleUrls = [];
                    for (const script of scripts) {
                        const src = script.getAttribute('src') || '';
                        if (src.includes('/client-web/') || src.includes('main.')) {
                            bundleUrls.push(src.startsWith('http') ? src : 'https://x.com' + src);
                        }
                    }
                    for (const bundleUrl of bundleUrls.slice(0, 8)) {
                        try {
                            const resp = await fetch(bundleUrl);
                            if (!resp.ok) continue;
                            const text = await resp.text();
                            const m = text.match(/queryId:"([A-Za-z0-9_-]+)",operationName:"CreateTweet"/);
                            if (m) {
                                createTweetQueryId = m[1];
                                break;
                            }
                        } catch (e) {}
                    }
                } catch (e) {}
            }
            return { success: true, createTweetQueryId, features };
        } catch (e) {
            return { success: false, error: e.message };
        }
    })();
    `;
}

/**
 * 生成通过 GraphQL CreateTweet 发表回复的浏览器端脚本
 * variables 结构随 X 前端可能变化，失败时由上层回退到 DOM
 *
 * @param {string} tweetId - 被回复的推文 ID
 * @param {string} replyText - 回复正文
 * @param {string} queryId - 动态发现的 CreateTweet queryId
 * @param {object} [features] - 可选 features
 */
function buildCreateReplyScript(tweetId, replyText, queryId, features) {
    const featuresToUse = features || DEFAULT_GRAPHQL_FEATURES;
    const featuresLiteral = JSON.stringify(featuresToUse);
    const variables = {
        tweet_text: replyText || '',
        reply: {
            in_reply_to_tweet_id: String(tweetId),
            exclude_reply_user_ids: []
        },
        dark_request: false
    };
    const variablesStr = JSON.stringify(variables).replace(/\\/g, '\\\\').replace(/`/g, '\\`');
    return `
    (async () => {
        try {
            const ct0 = document.cookie.match(/ct0=([^;]+)/)?.[1];
            if (!ct0) {
                return { success: false, error: '未找到 ct0 cookie，请确保已登录 X.com' };
            }
            const features = ${featuresLiteral};
            const apiUrl = 'https://x.com/i/api/graphql/${queryId}/CreateTweet';
            const body = JSON.stringify({
                variables: ${variablesStr},
                features: features,
                fieldToggles: { withArticleRichContentState: false }
            });
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);
            let response;
            try {
                response = await fetch(apiUrl, {
                    method: 'POST',
                    signal: controller.signal,
                    credentials: 'include',
                    headers: {
                        'authorization': '${BEARER_TOKEN}',
                        'x-csrf-token': ct0,
                        'x-twitter-auth-type': 'OAuth2Session',
                        'x-twitter-active-user': 'yes',
                        'content-type': 'application/json'
                    },
                    body: body
                });
                clearTimeout(timeoutId);
            } catch (fetchError) {
                clearTimeout(timeoutId);
                if (fetchError.name === 'AbortError') {
                    return { success: false, error: 'GraphQL 请求超时' };
                }
                return { success: false, error: fetchError.message };
            }
            if (!response.ok) {
                const text = await response.text().catch(() => '');
                return {
                    success: false,
                    error: 'HTTP ' + response.status,
                    statusCode: response.status
                };
            }
            const data = await response.json();
            const err = data?.errors?.[0];
            if (err) {
                return { success: false, error: err.message || JSON.stringify(err) };
            }
            if (data?.data?.create_tweet !== undefined && data?.data?.create_tweet?.result?.rest_id) {
                return { success: true, tweetId: data.data.create_tweet.result.rest_id };
            }
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    })();
    `;
}

/**
 * 优先尝试 GraphQL 发回复，失败则返回以便上层回退 DOM
 */
async function postReplyViaMutation(browser, tabId, tweetId, replyText, safeExecuteScript) {
    const disc = await safeExecuteScript(tabId, buildDiscoverCreateTweetQueryIdScript(), { timeout: 15000 });
    if (!disc?.success || !disc.createTweetQueryId) {
        return { success: false, error: '未发现 CreateTweet queryId' };
    }
    const script = buildCreateReplyScript(tweetId, replyText, disc.createTweetQueryId, disc.features);
    const result = await safeExecuteScript(tabId, script, { timeout: 20000 });
    return result || { success: false, error: '脚本未返回结果' };
}

// ============================================================================
// 发新帖：GraphQL（无 reply）
// ============================================================================

/**
 * 生成通过 GraphQL CreateTweet 发新帖（无 reply）的浏览器端脚本
 * variables 仅 tweet_text + dark_request，不传 reply
 *
 * @param {string} tweetText - 推文正文
 * @param {string} queryId - CreateTweet queryId
 * @param {object} [features] - 可选 features
 */
function buildCreateNewTweetScript(tweetText, queryId, features) {
    const featuresToUse = features || DEFAULT_GRAPHQL_FEATURES;
    const featuresLiteral = JSON.stringify(featuresToUse);
    const variables = {
        tweet_text: tweetText || '',
        dark_request: false
    };
    const variablesStr = JSON.stringify(variables).replace(/\\/g, '\\\\').replace(/`/g, '\\`');
    return `
    (async () => {
        try {
            const ct0 = document.cookie.match(/ct0=([^;]+)/)?.[1];
            if (!ct0) {
                return { success: false, error: '未找到 ct0 cookie，请确保已登录 X.com' };
            }
            const features = ${featuresLiteral};
            const apiUrl = 'https://x.com/i/api/graphql/${queryId}/CreateTweet';
            const body = JSON.stringify({
                variables: ${variablesStr},
                features: features,
                fieldToggles: { withArticleRichContentState: false }
            });
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);
            let response;
            try {
                response = await fetch(apiUrl, {
                    method: 'POST',
                    signal: controller.signal,
                    credentials: 'include',
                    headers: {
                        'authorization': '${BEARER_TOKEN}',
                        'x-csrf-token': ct0,
                        'x-twitter-auth-type': 'OAuth2Session',
                        'x-twitter-active-user': 'yes',
                        'content-type': 'application/json'
                    },
                    body: body
                });
                clearTimeout(timeoutId);
            } catch (fetchError) {
                clearTimeout(timeoutId);
                if (fetchError.name === 'AbortError') {
                    return { success: false, error: 'GraphQL 请求超时' };
                }
                return { success: false, error: fetchError.message };
            }
            if (!response.ok) {
                const text = await response.text().catch(() => '');
                return {
                    success: false,
                    error: 'HTTP ' + response.status,
                    statusCode: response.status
                };
            }
            const data = await response.json();
            const err = data?.errors?.[0];
            if (err) {
                return { success: false, error: err.message || JSON.stringify(err) };
            }
            if (data?.data?.create_tweet !== undefined && data?.data?.create_tweet?.result?.rest_id) {
                return { success: true, tweetId: data.data.create_tweet.result.rest_id };
            }
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    })();
    `;
}

async function postNewTweetViaMutation(browser, tabId, tweetText, safeExecuteScript) {
    const disc = await safeExecuteScript(tabId, buildDiscoverCreateTweetQueryIdScript(), { timeout: 15000 });
    if (!disc?.success || !disc.createTweetQueryId) {
        return { success: false, error: '未发现 CreateTweet queryId' };
    }
    const script = buildCreateNewTweetScript(tweetText, disc.createTweetQueryId, disc.features);
    const result = await safeExecuteScript(tabId, script, { timeout: 20000 });
    return result || { success: false, error: '脚本未返回结果' };
}

// ============================================================================
// 发新帖：先添加图片（可选）
// ============================================================================

const IMAGE_B64_CHUNK_SIZE = 32 * 1024; // 分块注入避免单次脚本过大导致截断/黑图

function escapeForJsDoubleQuote(s) {
    return (s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** 分块设置 window.__imgB64（避免整图 base64 内联导致消息截断或黑图） */
function buildSetComposerImageChunkScript(chunk, isFirst) {
    const safe = escapeForJsDoubleQuote(chunk);
    if (isFirst) {
        return `(function(){ window.__imgB64 = "${safe}"; })();`;
    }
    return `(function(){ window.__imgB64 = (window.__imgB64 || "") + "${safe}"; })();`;
}

/**
 * 用已注入的 window.__imgB64 在 composer 中设置文件输入（脚本内不含 base64，避免体积过大）
 */
function buildSetComposerImageApplyScript(mimeType, fileName) {
    const safeMime = (mimeType || 'image/png').replace(/"/g, '\\"');
    const safeName = (fileName || 'image.png').replace(/"/g, '\\"');
    return `
    (async () => {
        const delay = ms => new Promise(r => setTimeout(r, ms));
        try {
            var composerRoot = document.querySelector('[role="dialog"]') || document.querySelector('[data-testid="tweetComposer"]') || document.body;
            var tryExpand = function() {
                var btn = document.querySelector('[data-testid="SideNav_NewTweet_Button"]');
                if (btn && !document.querySelector('[data-testid="tweetTextarea_0"]')) {
                    btn.click();
                    return true;
                }
                return false;
            };
            tryExpand();
            await delay(1500);
            var textarea = document.querySelector('[data-testid="tweetTextarea_0"]');
            var composerScope = (textarea && textarea.closest('[role="dialog"]')) ? textarea.closest('[role="dialog"]') : (textarea && textarea.closest('[data-testid="tweetComposer"]')) ? textarea.closest('[data-testid="tweetComposer"]') : composerRoot;
            var fileInput = composerScope.querySelector('input[type="file"]');
            if (!fileInput) {
                var attachBtn = composerScope.querySelector('[data-testid="attachMedia"]') || composerScope.querySelector('[data-testid="fileInput"]');
                if (attachBtn && attachBtn.tagName === 'INPUT') {
                    fileInput = attachBtn;
                } else if (attachBtn) {
                    attachBtn.click();
                    await delay(1200);
                    fileInput = composerScope.querySelector('input[type="file"]');
                }
                if (!fileInput && composerScope !== document.body) {
                    var allInScope = composerScope.querySelectorAll('input[type="file"]');
                    fileInput = allInScope.length > 0 ? allInScope[0] : null;
                }
            }
            if (!fileInput) {
                return { success: false, error: '未找到发推框中的文件输入' };
            }
            var b64 = (window.__imgB64 || "").replace(/\s/g, "");
            if (!b64) {
                return { success: false, error: '未找到图片数据' };
            }
            var binary = atob(b64);
            var bytes = new Uint8Array(binary.length);
            for (var i = 0; i < binary.length; i++) { bytes[i] = binary.charCodeAt(i); }
            var blob = new Blob([bytes], { type: "${safeMime}" });
            var file = new File([blob], "${safeName}", { type: "${safeMime}" });
            var dt = new DataTransfer();
            dt.items.add(file);
            fileInput.files = dt.files;
            fileInput.dispatchEvent(new Event('input', { bubbles: true }));
            fileInput.dispatchEvent(new Event('change', { bubbles: true }));
            var dropZone = composerScope.querySelector('[data-testid="attachMedia"]') ? composerScope.querySelector('[data-testid="attachMedia"]').closest('div') || composerScope : composerScope;
            var file2 = new File([blob], "${safeName}", { type: "${safeMime}" });
            var dt2 = new DataTransfer();
            dt2.items.add(file2);
            dropZone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt2 }));
            dropZone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt2 }));
            await delay(2000);
            try { delete window.__imgB64; } catch (e) {}
            return { success: true, b64Len: b64.length, blobSize: blob.size };
        } catch (e) {
            try { delete window.__imgB64; } catch (err) {}
            return { success: false, error: e.message };
        }
    })();
    `;
}

async function setComposerImage(browser, tabId, imagePath, safeExecuteScript) {
    const ext = path.extname(imagePath).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    const name = path.basename(imagePath) || 'image' + ext;
    let base64;
    try {
        const buf = await fs.readFile(imagePath);
        base64 = buf.toString('base64');
    } catch (e) {
        return { success: false, error: '读取图片失败: ' + e.message };
    }
    const chunks = [];
    for (let i = 0; i < base64.length; i += IMAGE_B64_CHUNK_SIZE) {
        chunks.push(base64.slice(i, i + IMAGE_B64_CHUNK_SIZE));
    }
    for (let i = 0; i < chunks.length; i++) {
        const chunkScript = buildSetComposerImageChunkScript(chunks[i], i === 0);
        await safeExecuteScript(tabId, chunkScript, { timeout: 10000 });
    }
    const applyScript = buildSetComposerImageApplyScript(mime, name);
    const result = await safeExecuteScript(tabId, applyScript, { timeout: 25000 });
    return result || { success: false, error: '脚本未返回结果' };
}

// ============================================================================
// 发新帖：DOM 回退（首页 / intent）
// ============================================================================

/**
 * 生成在首页或 intent 页通过 DOM 发新帖的浏览器端脚本
 * 查找 composer（必要时先点击发推入口展开），填内容后点击 Post
 *
 * @param {string} tweetText - 推文正文
 * @returns {string} 可在浏览器中执行的 IIFE 脚本
 */
function buildNewTweetViaDomScript(tweetText) {
    const safeTweetText = JSON.stringify(tweetText || '');
    return `
    (async () => {
        const delay = ms => new Promise(r => setTimeout(r, ms));
        const tweetText = ${safeTweetText};
        try {
            var composerRoot = document.querySelector('[role="dialog"]') || document.querySelector('[data-testid="tweetComposer"]') || document.body;
            var isVisible = function(el) {
                if (!el || !el.getBoundingClientRect) return false;
                var r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && r.top < window.innerHeight && r.bottom > 0;
            };
            var tryExpandComposer = function() {
                var postBtn = document.querySelector('[data-testid="SideNav_NewTweet_Button"]');
                if (postBtn && !document.querySelector('[data-testid="tweetTextarea_0"]')) {
                    postBtn.click();
                    return true;
                }
                return false;
            };
            tryExpandComposer();
            await delay(1500);
            let textarea = null;
            for (var round = 0; round < 30; round++) {
                var candidates = composerRoot.querySelectorAll('[data-testid="tweetTextarea_0"], [role="textbox"][contenteditable="true"], [contenteditable="true"]');
                for (var k = 0; k < candidates.length; k++) {
                    if (isVisible(candidates[k])) {
                        textarea = candidates[k];
                        break;
                    }
                }
                if (textarea) break;
                await delay(400);
            }
            if (!textarea) {
                return { success: false, error: '未找到可见的发推输入框（等待超时）' };
            }
            textarea.scrollIntoView({ behavior: 'instant', block: 'center' });
            await delay(250);
            textarea.click();
            await delay(200);
            textarea.focus();
            await delay(200);
            if (textarea.contentEditable === 'true') {
                for (var ci = 0; ci < tweetText.length; ci++) {
                    var ch = tweetText[ci];
                    if (document.execCommand) {
                        document.execCommand('insertText', false, ch);
                    } else {
                        textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
                        textarea.textContent = (textarea.textContent || '') + ch;
                    }
                    await delay(25);
                }
                textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: tweetText }));
            } else {
                textarea.value = tweetText;
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
            }
            await delay(1200);
            textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: tweetText }));
            await delay(800);
            var root = composerRoot && composerRoot !== document.body ? composerRoot : document;
            let postBtn = null;
            for (var waitRound = 0; waitRound < 25; waitRound++) {
                postBtn = root.querySelector('[data-testid="tweetButtonInline"]');
                if (!postBtn) postBtn = root.querySelector('[data-testid="tweetButton"]');
                if (!postBtn) {
                    postBtn = Array.from(root.querySelectorAll('button[role="button"]')).find(function(b) {
                        if (!isVisible(b)) return false;
                        var t = (b.textContent || '').trim();
                        return (t === 'Post' || t === '发推');
                    });
                }
                if (postBtn && !postBtn.hasAttribute('disabled') && !postBtn.disabled && postBtn.getAttribute('aria-disabled') !== 'true') {
                    break;
                }
                postBtn = null;
                await delay(400);
            }
            if (!postBtn) {
                return { success: false, error: '未找到发送按钮' };
            }
            if (postBtn.hasAttribute('disabled') || postBtn.disabled || postBtn.getAttribute('aria-disabled') === 'true') {
                return { success: false, error: '发送按钮不可用（等待超时，可能未满足字数或权限）' };
            }
            postBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
            await delay(300);
            postBtn.click();
            await delay(2500);
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    })();
    `;
}

async function postNewTweetViaDom(browser, tabId, tweetText, safeExecuteScript) {
    const script = buildNewTweetViaDomScript(tweetText);
    const result = await safeExecuteScript(tabId, script, { timeout: 25000 });
    return result || { success: false, error: '脚本未返回结果' };
}

/**
 * 从当前页面获取指定内容推文的 ID（用于首页时间线发帖后取「刚发的那条」的 ID）
 * 若传入 matchText，会多等并重试，避免发帖后界面未及时更新导致找不到
 * @param {string} [matchText] - 若传入，则查找内容包含此文本的推文（用于串推第 1 条后精确定位自己发的）；不传则取页面第一条推文
 * @returns {string} 浏览器端脚本
 */
function buildGetFirstTweetIdFromPageScript(matchText) {
    const hasMatch = matchText != null && String(matchText).trim() !== '';
    const searchStr = hasMatch ? JSON.stringify(String(matchText).trim()) : 'null';
    return `
    (async () => {
        try {
            const delay = ms => new Promise(r => setTimeout(r, ms));
            const matchText = ${searchStr};
            var initialWait = matchText ? 5000 : 2000;
            var maxTries = matchText ? 5 : 1;
            for (var tryNum = 0; tryNum < maxTries; tryNum++) {
                await delay(tryNum === 0 ? initialWait : 2500);
                var articles = document.querySelectorAll('article[data-testid="tweet"]');
                var firstTweetId = null;
                for (var ai = 0; ai < articles.length; ai++) {
                    var art = articles[ai];
                    var link = art.querySelector('a[href*="/status/"]');
                    if (link && link.href) {
                        var mat = link.href.match(/status\\/(\\d+)/);
                        if (mat && !firstTweetId) firstTweetId = mat[1];
                        if (matchText) {
                            var tweetTextEl = art.querySelector('[data-testid="tweetText"]');
                            var bodyText = tweetTextEl ? (tweetTextEl.textContent || '').trim() : (art.textContent || '').trim();
                            var snippet = matchText.length > 30 ? matchText.substring(0, 30) : matchText;
                            if (bodyText.indexOf(matchText) === -1 && bodyText.indexOf(snippet) === -1) continue;
                        }
                        if (mat) return { success: true, tweetId: mat[1] };
                    }
                }
                if (matchText && firstTweetId) {
                    return { success: true, tweetId: firstTweetId, fallback: true };
                }
            }
            return { success: false, error: matchText ? '未找到内容匹配的推文 ID（界面可能尚未更新）' : '未找到推文 ID' };
        } catch (e) {
            return { success: false, error: e.message };
        }
    })();
    `;
}

async function getFirstTweetIdFromPage(tabId, safeExecuteScript, matchText) {
    const timeout = matchText ? 28000 : 12000;
    const result = await safeExecuteScript(tabId, buildGetFirstTweetIdFromPageScript(matchText), { timeout });
    return result;
}

// ============================================================================
// 主流程
// ============================================================================

async function main() {
    const options = parseArgs();

    const hasPost = options.post != null && String(options.post).trim() !== '';
    const hasThread = options.thread && options.thread.length > 0;

    if (options.tweetInputs.length === 0 && !hasPost && !hasThread) {
        console.error('错误: 请提供至少一个推文 URL/ID 或 --post/--thread');
        printUsage();
        process.exit(1);
    }

    if (hasPost && hasThread) {
        console.error('错误: --post 与 --thread 互斥，请只使用其一');
        printUsage();
        process.exit(1);
    }
    if ((hasPost || hasThread) && options.tweetInputs.length > 0) {
        console.error('错误: 发新帖/串推模式不能同时提供推文 URL 或 ID');
        printUsage();
        process.exit(1);
    }
    if ((hasPost || hasThread) && options.reply != null && String(options.reply).trim() !== '') {
        console.error('错误: 发新帖/串推模式不能与 --reply 同时使用');
        printUsage();
        process.exit(1);
    }

    const isReplyMode = options.reply != null && String(options.reply).trim() !== '';
    if (isReplyMode && options.tweetInputs.length > 1) {
        console.error('错误: 回复模式仅支持单条推文，请只提供一个 URL 或 ID');
        printUsage();
        process.exit(1);
    }

    const tweetIds = [];
    if (options.tweetInputs.length > 0) {
        for (const input of options.tweetInputs) {
            const id = extractTweetId(input);
            if (!id) {
                console.error(`错误: 无法解析推文 ID: "${input}"`);
                process.exit(1);
            }
            tweetIds.push(id);
        }
    }

    if (hasThread && options.thread.length > options.threadMax) {
        console.error(`错误: 串推条数 ${options.thread.length} 超过 --thread-max ${options.threadMax}`);
        printUsage();
        process.exit(1);
    }

    const isPostMode = hasPost || hasThread;

    let outputPath = options.output;
    let outputDir;
    if (!isPostMode) {
        if (!outputPath) {
            const timestamp = generateTimestamp();
            const dirName = tweetIds.length === 1
                ? `${tweetIds[0]}_${timestamp}`
                : `batch_${timestamp}`;
            outputDir = path.join(process.cwd(), 'work_dir', 'scrape', 'x_com_post', dirName);
            outputPath = path.join(outputDir, 'data.json');
        } else {
            if (!path.isAbsolute(outputPath)) {
                outputPath = path.join(process.cwd(), 'work_dir', 'scrape', 'x_com_post', outputPath);
            }
            outputDir = path.dirname(outputPath);
        }
    }

    console.log('='.repeat(60));
    console.log('X.com 帖子内容抓取工具');
    console.log('='.repeat(60));
    if (isPostMode) {
    if (hasPost) {
        console.log('模式: 发新帖（单条）');
        console.log(`内容: ${options.dryRun ? '(dry-run 不发送) ' : ''}"${String(options.post).slice(0, 60)}${String(options.post).length > 60 ? '...' : ''}"`);
        if (options.image) console.log('附带图片: ' + options.image);
    } else {
        console.log('模式: 串推（thread）');
        console.log(`条数: ${options.thread.length}`);
        options.thread.forEach((seg, i) => {
            console.log(`  ${i + 1}. ${String(seg).slice(0, 50)}${String(seg).length > 50 ? '...' : ''}`);
        });
        console.log(`段间延迟: ${options.threadDelay} ms`);
        if (options.image) console.log('第1条附带图片: ' + options.image);
        }
    } else {
        console.log(`推文数量: ${tweetIds.length}`);
        tweetIds.forEach((id, i) => {
            console.log(`  ${i + 1}. https://x.com/i/status/${id}`);
        });
        if (options.withThread) console.log('包含对话线程: 是');
        if (options.withReplies > 0) console.log(`包含回复数: ${options.withReplies}`);
        if (isReplyMode) {
            console.log('回复模式: 是');
            console.log('回复方式: ' + (options.replyStyle === 'reply' ? 'Replying to @xxx' : 'Thread（推文下点击回复）'));
            console.log(`回复内容: ${options.dryRun ? '(dry-run 不发送) ' : ''}"${String(options.reply).slice(0, 50)}${String(options.reply).length > 50 ? '...' : ''}"`);
        }
    }
    console.log(`关闭 Tab: ${options.closeTab ? '是' : '否（保留复用）'}`);
    if (!isPostMode) console.log(`输出文件: ${outputPath}`);
    console.log('='.repeat(60));

    const browser = new BrowserAutomation(options.browserServer);

    try {
        if (isPostMode) {
            const homeUrl = 'https://x.com/home';
            console.log('\n[发帖] 获取标签页并打开首页...');
            const tabResult = await acquireXTab(browser, homeUrl);
            const tabId = tabResult.tabId;
            try {
                if (!tabResult.isReused || tabResult.navigated) {
                    try { await waitForPageLoad(browser, tabId, { timeout: 30000 }); } catch (_) {}
                }
                await new Promise(r => setTimeout(r, 3500));
                const safeExecuteScript = createSafeExecuteScript(browser);

                if (options.dryRun) {
                    if (hasPost) {
                        console.log('--dry-run: 将发送新帖，内容为:');
                        console.log('  ' + String(options.post));
                    } else {
                        console.log('--dry-run: 将发送串推，共 ' + options.thread.length + ' 条:');
                        options.thread.forEach((seg, i) => console.log('  ' + (i + 1) + '. ' + seg));
                    }
                    console.log('(未实际发送)');
                } else if (hasPost) {
                    if (options.image) {
                        const imagePath = path.isAbsolute(options.image) ? options.image : path.join(process.cwd(), options.image);
                        const imgResult = await setComposerImage(browser, tabId, imagePath, safeExecuteScript);
                        if (!imgResult.success) {
                            console.error('添加图片失败:', imgResult.error || '未知');
                        } else {
                            if (imgResult.b64Len != null && imgResult.blobSize != null) {
                                console.log('已添加图片 (base64 长度:', imgResult.b64Len, ', blob 大小:', imgResult.blobSize, ')，正在填写正文并发送...');
                            } else {
                                console.log('已添加图片，正在填写正文并发送...');
                            }
                        }
                        await new Promise(r => setTimeout(r, 1500));
                    }
                    const result = await postNewTweetViaDom(browser, tabId, options.post, safeExecuteScript);
                    if (result.success) {
                        console.log('新帖已发送' + (result.tweetId ? '，ID: ' + result.tweetId : ''));
                    } else {
                        console.error('发新帖失败:', result.error || '未知错误');
                    }
                } else {
                    const postedIds = [];
                    let lastId = null;
                    const delayMs = Math.max(2000, options.threadDelay);
                    for (let i = 0; i < options.thread.length; i++) {
                        if (i > 0) {
                            console.log(`  等待 ${delayMs / 1000} 秒间隔...`);
                            await new Promise(r => setTimeout(r, delayMs));
                        }
                        const text = options.thread[i];
                        let result;
                        if (i === 0) {
                            if (options.image) {
                                const imagePath = path.isAbsolute(options.image) ? options.image : path.join(process.cwd(), options.image);
                                const imgResult = await setComposerImage(browser, tabId, imagePath, safeExecuteScript);
                                if (!imgResult.success) {
                                    console.error('添加图片失败:', imgResult.error || '未知');
                                } else {
                                    if (imgResult.b64Len != null && imgResult.blobSize != null) {
                                        console.log('  已添加图片 (base64 长度:', imgResult.b64Len, ', blob 大小:', imgResult.blobSize, ')，正在填写第1条并发送...');
                                    } else {
                                        console.log('  已添加图片，正在填写第1条并发送...');
                                    }
                                }
                                await new Promise(r => setTimeout(r, 1500));
                            }
                            result = await postNewTweetViaDom(browser, tabId, text, safeExecuteScript);
                            if (result.success) {
                                console.log(`  等待 ${delayMs / 1000} 秒间隔...`);
                                await new Promise(r => setTimeout(r, delayMs));
                                const idResult = await getFirstTweetIdFromPage(tabId, safeExecuteScript, text);
                                if (idResult?.success && idResult.tweetId) {
                                    lastId = idResult.tweetId;
                                    postedIds.push(lastId);
                                }
                            }
                        } else {
                            await browser.openUrl('https://x.com/i/status/' + lastId, tabId);
                            await new Promise(r => setTimeout(r, 5000));
                            result = await postReplyViaDom(browser, tabId, lastId, text, safeExecuteScript);
                            if (result.success && result.tweetId) {
                                lastId = result.tweetId;
                                postedIds.push(lastId);
                            }
                        }
                        if (result && result.success) {
                            console.log(`  [${i + 1}/${options.thread.length}] 已发送`);
                        } else if (result && !result.success) {
                            console.error(`  [${i + 1}/${options.thread.length}] 失败: ${result.error || '未知错误'}`);
                            break;
                        }
                        if (i === 0 && result && result.success && !lastId) {
                            console.log('  [1/' + options.thread.length + '] 已发送（未取得 ID，后续条数无法继续）');
                            break;
                        }
                    }
                    if (postedIds.length > 0) {
                        console.log('串推已发送 ' + postedIds.length + ' 条，ID: ' + postedIds.join(', '));
                    }
                }
            } finally {
                await releaseXTab(browser, tabId, !options.closeTab);
            }
        } else {
            const result = await getPost(browser, tweetIds, {
                ...options,
                logger: console,
            });

            const output = options.pretty
                ? JSON.stringify(result, null, 2)
                : JSON.stringify(result);
            await saveToFile(outputPath, output);

            const successResults = result.results.filter(r => r.success);
            const failedResults = result.results.filter(r => !r.success);

            console.log('\n' + '='.repeat(60));
            console.log('抓取完成');
            console.log('='.repeat(60));
            console.log(`成功: ${successResults.length} / ${result.totalRequested}`);
            if (failedResults.length > 0) {
                console.log(`失败: ${failedResults.length}`);
                failedResults.forEach(r => console.log(`  - ${r.tweetId}: ${r.error}`));
            }
            if (successResults.length > 0) {
                const totalLikes = successResults.reduce((sum, t) => sum + (t.stats?.likes || 0), 0);
                const totalRetweets = successResults.reduce((sum, t) => sum + (t.stats?.retweets || 0), 0);
                const totalViews = successResults.reduce((sum, t) => sum + (t.stats?.views || 0), 0);
                const totalMedia = successResults.reduce((sum, t) => sum + (t.mediaUrls?.length || 0), 0);
                console.log(`\n总点赞: ${totalLikes.toLocaleString()}`);
                console.log(`总转发: ${totalRetweets.toLocaleString()}`);
                console.log(`总查看: ${totalViews.toLocaleString()}`);
                if (totalMedia > 0) console.log(`总媒体: ${totalMedia} 个`);
            }
            console.log('='.repeat(60));

            if (isReplyMode) {
                const replyTweetId = tweetIds[0];
                const useIntent = options.replyStyle === 'reply';
                const replyUrl = useIntent
                    ? `https://x.com/intent/tweet?in_reply_to=${replyTweetId}`
                    : `https://x.com/i/status/${replyTweetId}`;
                console.log('\n[回复] ' + (useIntent ? 'Replying to 式' : 'Thread 式') + '，获取标签页并打开...');
                const tabResult = await acquireXTab(browser, replyUrl);
                const tabId = tabResult.tabId;
                try {
                    if (!tabResult.isReused || tabResult.navigated) {
                        try { await waitForPageLoad(browser, tabId, { timeout: 30000 }); } catch (_) {}
                    }
                    await new Promise(r => setTimeout(r, useIntent ? 3500 : 4000));
                    if (options.dryRun) {
                        console.log('--dry-run: 将对该推文发送回复，内容为:');
                        console.log('  ' + String(options.reply));
                        console.log('(未实际发送)');
                    } else {
                        const safeExecuteScript = createSafeExecuteScript(browser);
                        const replyResult = useIntent
                            ? await postReplyViaIntent(browser, tabId, options.reply, safeExecuteScript)
                            : await postReplyViaDom(browser, tabId, replyTweetId, options.reply, safeExecuteScript);
                        if (replyResult.success) {
                            console.log('回复已发送');
                        } else {
                            console.error('回复失败:', replyResult.error || '未知错误');
                        }
                    }
                } finally {
                    await releaseXTab(browser, tabId, !options.closeTab);
                }
            }
        }

        browser.disconnect();

    } catch (error) {
        console.error('\n✗ 抓取失败:');
        console.error(error.message);
        if (error.stack) {
            console.error('\n堆栈跟踪:');
            console.error(error.stack);
        }
        browser.disconnect();
        process.exit(1);
    }
}

module.exports = {
    main,
    parseArgs,
    extractTweetId,
    buildDiscoverTweetQueryIdsScript,
    buildTweetDetailScript,
    buildTweetDetailCursorScript,
    buildParseTweetResultSnippet,
    buildTweetByRestIdScript,
    buildPostDomScript,
    buildReplyViaDomScript,
    postReplyViaDom,
    buildReplyViaIntentScript,
    postReplyViaIntent,
    buildDiscoverCreateTweetQueryIdScript,
    buildCreateReplyScript,
    postReplyViaMutation,
    buildCreateNewTweetScript,
    postNewTweetViaMutation,
    buildNewTweetViaDomScript,
    postNewTweetViaDom
};

if (require.main === module) {
    main().catch(error => {
        console.error('未处理的错误:', error);
        process.exit(1);
    });
}
