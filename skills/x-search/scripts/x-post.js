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
 * 
 * 注意:
 *   - 需要 JS-Eyes Server 运行中，且浏览器已安装 JS-Eyes 扩展并登录 X.com
 *   - X.com 需要登录状态才能访问 GraphQL API
 *   - 默认不关闭 tab，下次运行可秒级复用已有的 x.com 标签页
 */

const { BrowserAutomation } = require('../lib/js-eyes-client');
const path = require('path');
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
        closeTab: false
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg.startsWith('--')) {
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
                default:
                    console.warn(`未知选项: ${arg}`);
            }
        } else {
            // 位置参数：推文 URL 或 ID
            options.tweetInputs.push(arg);
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
    console.log('\n选项:');
    console.log('  --with-thread              抓取完整对话线程（默认只抓取指定推文）');
    console.log('  --with-replies <number>    包含回复数，支持分页翻页（默认0，不抓取回复）');
    console.log('  --pretty                   美化 JSON 输出');
    console.log('  --browser-server <url>     浏览器服务器地址');
    console.log('  --output <file>            指定输出文件路径');
    console.log('  --close-tab                抓完后关闭 tab（默认保留）');
    console.log('\n示例:');
    console.log('  node scripts/x-post.js https://x.com/elonmusk/status/1234567890');
    console.log('  node scripts/x-post.js 1234567890 9876543210 --pretty');
    console.log('  node scripts/x-post.js https://x.com/user/status/123 --with-thread');
    console.log('  node scripts/x-post.js https://x.com/user/status/123 --with-replies 100');
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
// 主流程
// ============================================================================

async function main() {
    const options = parseArgs();

    if (options.tweetInputs.length === 0) {
        console.error('错误: 请提供至少一个推文 URL 或 ID');
        printUsage();
        process.exit(1);
    }

    const tweetIds = [];
    for (const input of options.tweetInputs) {
        const id = extractTweetId(input);
        if (!id) {
            console.error(`错误: 无法解析推文 ID: "${input}"`);
            process.exit(1);
        }
        tweetIds.push(id);
    }

    let outputPath = options.output;
    let outputDir;
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

    console.log('='.repeat(60));
    console.log('X.com 帖子内容抓取工具');
    console.log('='.repeat(60));
    console.log(`推文数量: ${tweetIds.length}`);
    tweetIds.forEach((id, i) => {
        console.log(`  ${i + 1}. https://x.com/i/status/${id}`);
    });
    if (options.withThread) console.log('包含对话线程: 是');
    if (options.withReplies > 0) console.log(`包含回复数: ${options.withReplies}`);
    console.log(`关闭 Tab: ${options.closeTab ? '是' : '否（保留复用）'}`);
    console.log(`输出文件: ${outputPath}`);
    console.log('='.repeat(60));

    const browser = new BrowserAutomation(options.browserServer);

    try {
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
    buildPostDomScript
};

if (require.main === module) {
    main().catch(error => {
        console.error('未处理的错误:', error);
        process.exit(1);
    });
}
