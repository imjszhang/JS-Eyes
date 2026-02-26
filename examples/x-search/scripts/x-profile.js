#!/usr/bin/env node

/**
 * X.com (Twitter) 用户帖子抓取脚本
 * 使用 GraphQL UserByScreenName + UserTweets API 抓取指定用户的全部帖子
 * 
 * 使用方法:
 *   node scripts/x-profile.js <username> [options]
 * 
 * 选项:
 *   --max-pages <number>       最多翻页数（默认50，每页约20条）
 *   --max-tweets <number>      最多抓取推文数（达到后停止）
 *   --since <date>             起始日期 YYYY-MM-DD（跳过更早的帖子）
 *   --until <date>             截止日期 YYYY-MM-DD
 *   --include-replies          包含回复（默认不包含）
 *   --include-retweets         包含转推（默认不包含）
 *   --min-likes <number>       最低点赞过滤（默认0）
 *   --min-retweets <number>    最低转发过滤（默认0）
 *   --pretty                   美化 JSON 输出
 *   --browser-server <url>     JS-Eyes WebSocket 服务器地址（默认 ws://localhost:18080）
 *   --output <file>            指定输出文件路径
 *   --close-tab                抓完后关闭 tab（默认保留供下次复用）
 *   --resume <dir>             从中断的抓取目录恢复继续
 * 
 * 文件保存位置:
 *   work_dir/scrape/x_com_profile/{username}_{timestamp}/data.json
 * 
 * 示例:
 *   node scripts/x-profile.js elonmusk
 *   node scripts/x-profile.js elonmusk --max-pages 10 --pretty
 *   node scripts/x-profile.js elonmusk --since 2025-01-01 --until 2025-06-01
 *   node scripts/x-profile.js elonmusk --max-tweets 500 --min-likes 100
 *   node scripts/x-profile.js elonmusk --include-replies --include-retweets
 *   node scripts/x-profile.js elonmusk --close-tab
 *   node scripts/x-profile.js --resume work_dir/scrape/x_com_profile/elonmusk_2025-01-01T12-00-00
 * 
 * 注意:
 *   - 需要 JS-Eyes Server 运行中，且浏览器已安装 JS-Eyes 扩展并登录 X.com
 *   - X.com 需要登录状态才能访问用户时间线
 *   - 默认不关闭 tab，下次运行可秒级复用已有的 x.com 标签页
 */

const { BrowserAutomation } = require('../../../clients/js-eyes-client');
const path = require('path');
const {
    DEFAULT_USER_FEATURES,
    BEARER_TOKEN,
    buildTweetParserSnippet,
    buildGraphQLTweetParserSnippet,
    retryWithBackoff,
    saveProgress,
    loadProgress,
    appendPartialTweets,
    loadPartialTweets,
    cleanupTempFiles,
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
        username: null,
        maxPages: 50,
        maxTweets: 0,       // 0 = 不限制
        pretty: false,
        browserServer: null,
        output: null,
        minLikes: 0,
        minRetweets: 0,
        since: null,
        until: null,
        includeReplies: false,
        includeRetweets: false,
        closeTab: false,
        resume: null
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg.startsWith('--')) {
            const key = arg.replace('--', '').replace(/-/g, '');
            const nextArg = args[i + 1];

            switch (key) {
                case 'maxpages':
                    options.maxPages = parseInt(nextArg, 10) || 50;
                    i++;
                    break;
                case 'maxtweets':
                    options.maxTweets = parseInt(nextArg, 10) || 0;
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
                case 'minlikes':
                    options.minLikes = parseInt(nextArg, 10) || 0;
                    i++;
                    break;
                case 'minretweets':
                    options.minRetweets = parseInt(nextArg, 10) || 0;
                    i++;
                    break;
                case 'since':
                    options.since = nextArg;
                    i++;
                    break;
                case 'until':
                    options.until = nextArg;
                    i++;
                    break;
                case 'includereplies':
                    options.includeReplies = true;
                    break;
                case 'includeretweets':
                    options.includeRetweets = true;
                    break;
                case 'closetab':
                    options.closeTab = true;
                    break;
                case 'resume':
                    options.resume = nextArg;
                    i++;
                    break;
                default:
                    console.warn(`未知选项: ${arg}`);
            }
        } else if (!options.username) {
            // 去掉可能的 @ 前缀
            options.username = arg.replace(/^@/, '');
        }
    }

    return options;
}

// ============================================================================
// GraphQL queryId 发现脚本
// ============================================================================

/**
 * 生成动态发现 UserByScreenName 和 UserTweets queryId 的浏览器端脚本
 * 
 * 发现策略：
 * 1. 从 performance.getEntriesByType('resource') 匹配已有请求
 * 2. 回退到扫描 JS bundle
 */
function buildDiscoverUserQueryIdsScript() {
    return `
    (async () => {
        try {
            const result = {
                userByScreenNameQueryId: null,
                userTweetsQueryId: null,
                userTweetsAndRepliesQueryId: null,
                features: null
            };
            
            // 策略 1: 从 performance API 中匹配
            try {
                const resources = performance.getEntriesByType('resource');
                for (const r of resources) {
                    if (!result.userByScreenNameQueryId) {
                        const m = r.name.match(/graphql\\/([A-Za-z0-9_-]+)\\/UserByScreenName/);
                        if (m) {
                            result.userByScreenNameQueryId = m[1];
                            // 尝试从 URL 提取 features
                            if (!result.features) {
                                try {
                                    const url = new URL(r.name);
                                    const fp = url.searchParams.get('features');
                                    if (fp) result.features = JSON.parse(fp);
                                } catch (e) {}
                            }
                        }
                    }
                    if (!result.userTweetsQueryId) {
                        // 匹配 UserTweets 但不匹配 UserTweetsAndReplies
                        const m = r.name.match(/graphql\\/([A-Za-z0-9_-]+)\\/UserTweets(?!And)/);
                        if (m) {
                            result.userTweetsQueryId = m[1];
                            if (!result.features) {
                                try {
                                    const url = new URL(r.name);
                                    const fp = url.searchParams.get('features');
                                    if (fp) result.features = JSON.parse(fp);
                                } catch (e) {}
                            }
                        }
                    }
                    if (!result.userTweetsAndRepliesQueryId) {
                        const m = r.name.match(/graphql\\/([A-Za-z0-9_-]+)\\/UserTweetsAndReplies/);
                        if (m) result.userTweetsAndRepliesQueryId = m[1];
                    }
                }
            } catch (e) {}
            
            // 策略 2: 从 JS bundle 中搜索
            if (!result.userByScreenNameQueryId || !result.userTweetsQueryId) {
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
                            
                            if (!result.userByScreenNameQueryId) {
                                const m = text.match(/queryId:"([A-Za-z0-9_-]+)",operationName:"UserByScreenName"/);
                                if (m) result.userByScreenNameQueryId = m[1];
                            }
                            if (!result.userTweetsQueryId) {
                                const m = text.match(/queryId:"([A-Za-z0-9_-]+)",operationName:"UserTweets"/);
                                if (m) result.userTweetsQueryId = m[1];
                            }
                            if (!result.userTweetsAndRepliesQueryId) {
                                const m = text.match(/queryId:"([A-Za-z0-9_-]+)",operationName:"UserTweetsAndReplies"/);
                                if (m) result.userTweetsAndRepliesQueryId = m[1];
                            }
                            
                            if (result.userByScreenNameQueryId && result.userTweetsQueryId) break;
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
// UserByScreenName GraphQL 脚本
// ============================================================================

/**
 * 生成 UserByScreenName GraphQL API 调用脚本
 * 返回 rest_id（数字用户 ID）和 profile 元信息
 * 
 * @param {string} screenName - 用户名（不带 @）
 * @param {string} queryId - 动态发现的 queryId
 * @param {Object} [features] - 动态发现的 features
 * @returns {string} JS 代码字符串
 */
function buildUserByScreenNameScript(screenName, queryId, features) {
    const safeScreenName = screenName.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
    const featuresToUse = features || DEFAULT_USER_FEATURES;
    const featuresLiteral = JSON.stringify(featuresToUse);
    
    return `
    (async () => {
        try {
            const ct0 = document.cookie.match(/ct0=([^;]+)/)?.[1];
            if (!ct0) {
                return { success: false, error: '未找到 ct0 cookie，请确保已登录 X.com' };
            }
            
            const variables = {
                screen_name: '${safeScreenName}',
                withSafetyModeUserFields: true
            };
            
            const fieldToggles = {
                withAuxiliaryUserLabels: false
            };
            
            const features = ${featuresLiteral};
            
            const apiUrl = 'https://x.com/i/api/graphql/${queryId}/UserByScreenName?' +
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
                return { 
                    success: false, 
                    error: 'HTTP ' + response.status,
                    statusCode: response.status,
                    retryAfter: retryAfter ? parseInt(retryAfter, 10) : null
                };
            }
            
            const data = await response.json();
            
            try {
                const userResult = data?.data?.user?.result;
                if (!userResult) {
                    return { success: false, error: '用户不存在或已被封禁' };
                }
                
                const legacy = userResult.legacy || {};
                const core = userResult.core || {};
                const avatar = userResult.avatar || {};
                const loc = userResult.location || {};
                
                return {
                    success: true,
                    userId: userResult.rest_id,
                    profile: {
                        name: core.name || legacy.name || '',
                        screenName: core.screen_name || legacy.screen_name || '${safeScreenName}',
                        bio: legacy.description || userResult.profile_bio?.description || '',
                        location: (typeof loc === 'string' ? loc : loc.location || legacy.location || ''),
                        website: legacy.entities?.url?.urls?.[0]?.expanded_url || '',
                        followersCount: legacy.followers_count || 0,
                        followingCount: legacy.friends_count || 0,
                        tweetCount: legacy.statuses_count || 0,
                        listedCount: legacy.listed_count || 0,
                        joinDate: core.created_at || legacy.created_at || '',
                        avatarUrl: avatar.image_url || legacy.profile_image_url_https || '',
                        bannerUrl: legacy.profile_banner_url || '',
                        isVerified: userResult.is_blue_verified || false,
                        isProtected: (userResult.privacy && userResult.privacy.protected) || legacy.protected || false
                    }
                };
            } catch (parseError) {
                return { success: false, error: '解析用户信息失败: ' + parseError.message };
            }
        } catch (e) {
            return { success: false, error: e.message };
        }
    })();
    `;
}

// ============================================================================
// UserTweets GraphQL 脚本
// ============================================================================

/**
 * 生成 UserTweets (或 UserTweetsAndReplies) GraphQL API 调用脚本
 * 
 * @param {string} userId - 用户数字 ID (rest_id)
 * @param {string} cursor - 分页游标（首页为 null）
 * @param {string} queryId - 动态发现的 queryId
 * @param {Object} [features] - 动态发现的 features
 * @param {boolean} [includeReplies=false] - 是否使用 UserTweetsAndReplies API
 * @returns {string} JS 代码字符串
 */
function buildUserTweetsScript(userId, cursor, queryId, features, includeReplies = false) {
    const safeCursor = (cursor || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
    const featuresToUse = features || DEFAULT_USER_FEATURES;
    const featuresLiteral = JSON.stringify(featuresToUse);
    const operationName = includeReplies ? 'UserTweetsAndReplies' : 'UserTweets';
    
    return `
    (async () => {
        try {
            const ct0 = document.cookie.match(/ct0=([^;]+)/)?.[1];
            if (!ct0) {
                return { success: false, error: '未找到 ct0 cookie，请确保已登录 X.com' };
            }
            
            ${buildGraphQLTweetParserSnippet()}
            
            const variables = {
                userId: '${userId}',
                count: 20,
                includePromotedContent: false,
                withQuickPromoteEligibilityTweetFields: true,
                withVoice: true,
                withV2Timeline: true
            };
            
            ${safeCursor ? `variables.cursor = '${safeCursor}';` : ''}
            
            const features = ${featuresLiteral};
            
            const apiUrl = 'https://x.com/i/api/graphql/${queryId}/${operationName}?' +
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
                const userResult = data?.data?.user?.result;
                const timeline = userResult?.timeline_v2?.timeline 
                    || userResult?.timeline?.timeline;
                const instructions = timeline?.instructions || [];
                
                // 从 instructions 中提取所有 entries（parseTweetEntries 接受扁平 entries 数组）
                let allEntries = [];
                for (const instruction of instructions) {
                    if (instruction.type === 'TimelineAddEntries' && instruction.entries) {
                        allEntries = allEntries.concat(instruction.entries);
                    }
                    // TimelinePinEntry 包含置顶推文
                    if (instruction.type === 'TimelinePinEntry' && instruction.entry) {
                        allEntries.unshift(instruction.entry);
                    }
                }
                
                const { tweets, nextCursor } = parseTweetEntries(allEntries);
                
                return {
                    success: true,
                    tweets: tweets,
                    nextCursor: nextCursor
                };
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
// DOM 回退脚本（用户主页）
// ============================================================================

/**
 * 生成用户主页 DOM 滚动提取脚本（回退方案）
 * 在用户主页滚动并提取可见推文
 */
function buildProfileDomScript() {
    return `
    (async () => {
        try {
            const delay = ms => new Promise(r => setTimeout(r, ms));
            
            ${buildTweetParserSnippet()}
            
            const seenIds = new Set();
            const allTweets = [];
            
            const extractCurrentTweets = () => {
                const articles = document.querySelectorAll('article[data-testid="tweet"]');
                let newCount = 0;
                
                articles.forEach(article => {
                    try {
                        const tweet = parseTweetArticle(article);
                        if (tweet && !seenIds.has(tweet.tweetId)) {
                            seenIds.add(tweet.tweetId);
                            allTweets.push(tweet);
                            newCount++;
                        }
                    } catch (e) { /* skip */ }
                });
                
                return newCount;
            };
            
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
                return { success: false, error: '未检测到推文，可能未登录或用户无帖子', tweets: [] };
            }
            
            extractCurrentTweets();
            
            // 滚动提取
            const maxScrollRounds = 8;
            let noNewCount = 0;
            
            for (let i = 0; i < maxScrollRounds; i++) {
                window.scrollTo(0, document.documentElement.scrollHeight);
                await delay(2000);
                
                const newFound = extractCurrentTweets();
                if (newFound === 0) {
                    noNewCount++;
                    if (noNewCount >= 2) break;
                } else {
                    noNewCount = 0;
                }
            }
            
            return { success: true, tweets: allTweets, tweetCount: allTweets.length };
        } catch (e) {
            return { success: false, error: e.message, tweets: [] };
        }
    })();
    `;
}

// ============================================================================
// 辅助函数
// ============================================================================

function printUsage() {
    console.error('错误: 请提供用户名');
    console.log('\n使用方法:');
    console.log('  node scripts/x-profile.js <username> [options]');
    console.log('\n选项:');
    console.log('  --max-pages <number>       最多翻页数（默认50，每页约20条）');
    console.log('  --max-tweets <number>      最多抓取推文数（达到后停止）');
    console.log('  --since <date>             起始日期（YYYY-MM-DD）');
    console.log('  --until <date>             截止日期（YYYY-MM-DD）');
    console.log('  --include-replies          包含回复（默认不包含）');
    console.log('  --include-retweets         包含转推（默认不包含）');
    console.log('  --min-likes <number>       最低点赞过滤（默认0）');
    console.log('  --min-retweets <number>    最低转发过滤（默认0）');
    console.log('  --pretty                   美化 JSON 输出');
    console.log('  --browser-server <url>     浏览器服务器地址');
    console.log('  --output <file>            指定输出文件路径');
    console.log('  --close-tab                抓完后关闭 tab（默认保留）');
    console.log('  --resume <dir>             从中断的抓取目录恢复继续');
    console.log('\n示例:');
    console.log('  node scripts/x-profile.js elonmusk');
    console.log('  node scripts/x-profile.js elonmusk --max-pages 10 --pretty');
    console.log('  node scripts/x-profile.js elonmusk --since 2025-01-01 --max-tweets 500');
    console.log('  node scripts/x-profile.js elonmusk --include-replies --include-retweets');
    console.log('  node scripts/x-profile.js elonmusk --close-tab');
    console.log('  node scripts/x-profile.js --resume work_dir/scrape/x_com_profile/elonmusk_2025-01-01T12-00-00');
}

/**
 * 解析推文的 created_at 时间字符串为 Date 对象
 * Twitter 格式: "Wed Oct 10 20:19:24 +0000 2018" 或 ISO 格式
 * @param {string} dateStr
 * @returns {Date|null}
 */
function parseTweetDate(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? null : d;
}

/**
 * 检查推文是否早于 since 日期
 * @param {Object} tweet
 * @param {string} sinceDate - YYYY-MM-DD
 * @returns {boolean} true = 推文早于 since（应停止翻页）
 */
function isTweetBeforeSince(tweet, sinceDate) {
    if (!sinceDate) return false;
    const tweetDate = parseTweetDate(tweet.publishTime);
    if (!tweetDate) return false;
    const since = new Date(sinceDate + 'T00:00:00Z');
    return tweetDate < since;
}

/**
 * 检查推文是否晚于 until 日期
 * @param {Object} tweet
 * @param {string} untilDate - YYYY-MM-DD
 * @returns {boolean} true = 推文晚于 until（应跳过）
 */
function isTweetAfterUntil(tweet, untilDate) {
    if (!untilDate) return false;
    const tweetDate = parseTweetDate(tweet.publishTime);
    if (!tweetDate) return false;
    const until = new Date(untilDate + 'T23:59:59Z');
    return tweetDate > until;
}

/**
 * 过滤推文（排除回复、转推、日期范围等）
 * @param {Array} tweets - 原始推文数组
 * @param {Object} options - 过滤选项
 * @returns {{ filtered: Array, hitSinceLimit: boolean }}
 */
function filterTweets(tweets, options) {
    const filtered = [];
    let hitSinceLimit = false;
    
    for (const tweet of tweets) {
        // 检查是否早于 since，如果是则标记停止
        if (isTweetBeforeSince(tweet, options.since)) {
            hitSinceLimit = true;
            continue;
        }
        
        // 跳过晚于 until 的推文
        if (isTweetAfterUntil(tweet, options.until)) {
            continue;
        }
        
        // 排除回复（除非 includeReplies）
        if (!options.includeReplies && tweet.isReply) {
            continue;
        }
        
        // 排除转推（除非 includeRetweets）
        if (!options.includeRetweets && tweet.isRetweet) {
            continue;
        }
        
        filtered.push(tweet);
    }
    
    return { filtered, hitSinceLimit };
}

// ============================================================================
// 主流程
// ============================================================================

async function main() {
    const options = parseArgs();

    // 处理 --resume 模式
    if (options.resume) {
        return await resumeProfile(options);
    }

    if (!options.username) {
        printUsage();
        process.exit(1);
    }

    const username = options.username;
    const profileUrl = `https://x.com/${username}`;

    // 确定输出路径和目录
    let outputPath = options.output;
    let outputDir;
    if (!outputPath) {
        const safeUsername = username.replace(/[\/\\:*?"<>|]/g, '_').substring(0, 50);
        const timestamp = generateTimestamp();
        const dirName = `${safeUsername}_${timestamp}`;
        outputDir = path.join(process.cwd(), 'work_dir', 'scrape', 'x_com_profile', dirName);
        outputPath = path.join(outputDir, 'data.json');
    } else {
        if (!path.isAbsolute(outputPath)) {
            outputPath = path.join(process.cwd(), 'work_dir', 'scrape', 'x_com_profile', outputPath);
        }
        outputDir = path.dirname(outputPath);
    }

    // 打印信息
    console.log('='.repeat(60));
    console.log('X.com 用户帖子抓取工具');
    console.log('='.repeat(60));
    console.log(`用户名: @${username}`);
    console.log(`用户主页: ${profileUrl}`);
    console.log(`最多页数: ${options.maxPages}`);
    if (options.maxTweets > 0) console.log(`最多推文数: ${options.maxTweets}`);
    if (options.since) console.log(`起始日期: ${options.since}`);
    if (options.until) console.log(`截止日期: ${options.until}`);
    console.log(`包含回复: ${options.includeReplies ? '是' : '否'}`);
    console.log(`包含转推: ${options.includeRetweets ? '是' : '否'}`);
    if (options.minLikes > 0) console.log(`最低点赞: ${options.minLikes}`);
    if (options.minRetweets > 0) console.log(`最低转发: ${options.minRetweets}`);
    console.log(`关闭 Tab: ${options.closeTab ? '是' : '否（保留复用）'}`);
    console.log(`输出文件: ${outputPath}`);
    console.log('='.repeat(60));

    const browser = new BrowserAutomation(options.browserServer);
    const safeExecuteScript = createSafeExecuteScript(browser);
    let tabId = null;
    const allTweets = [];
    const seenIds = new Set();
    let userProfile = null;

    // 自适应翻页间隔（比搜索更保守）
    let pageDelay = 3000;
    const MIN_PAGE_DELAY = 3000;
    const MAX_PAGE_DELAY = 8000;

    // 连续 429 计数
    let consecutive429Count = 0;
    const MAX_CONSECUTIVE_429 = 3;
    const LONG_PAUSE_MS = 5 * 60 * 1000; // 5 分钟

    try {
        // ================================================================
        // Phase 1: 获取 Tab（域级别复用）
        // ================================================================
        console.log('\n[Phase 1] 获取浏览器标签页...');
        
        const tabResult = await acquireXTab(browser, profileUrl);
        tabId = tabResult.tabId;
        
        // 如果是新建或同域内导航，等待页面加载
        if (!tabResult.isReused || tabResult.navigated) {
            console.log('等待页面加载...');
            try {
                await waitForPageLoad(browser, tabId, { timeout: 30000 });
                console.log('✓ 页面加载完成');
            } catch (e) {
                console.warn(`⚠ 等待页面加载超时，继续执行: ${e.message}`);
            }
        }
        
        // 等待 X.com 完成 client-side 渲染
        const renderWait = tabResult.isReused && !tabResult.navigated ? 1000 : 4000;
        console.log(`等待页面渲染 (${renderWait / 1000}s)...`);
        await new Promise(resolve => setTimeout(resolve, renderWait));

        // ================================================================
        // Phase 2: 发现 GraphQL 参数（带缓存）
        // ================================================================
        console.log('\n[Phase 2] 获取 GraphQL 参数...');
        let graphqlParams = {};
        
        // 先尝试读缓存
        const cacheKey = 'UserProfile';
        const cached = await loadGraphQLCache(cacheKey);
        if (cached && cached.userByScreenNameQueryId && cached.userTweetsQueryId) {
            graphqlParams = cached;
            console.log(`✓ 使用缓存的 queryId: UserByScreenName=${cached.userByScreenNameQueryId}, UserTweets=${cached.userTweetsQueryId}`);
        } else {
            // 缓存未命中，动态发现
            console.log('缓存未命中，执行动态发现...');
            try {
                const discoveryResult = await safeExecuteScript(
                    tabId,
                    buildDiscoverUserQueryIdsScript(),
                    { timeout: 60 }
                );
                
                if (discoveryResult?.success) {
                    if (discoveryResult.userByScreenNameQueryId) {
                        graphqlParams.userByScreenNameQueryId = discoveryResult.userByScreenNameQueryId;
                        console.log(`✓ UserByScreenName queryId: ${discoveryResult.userByScreenNameQueryId}`);
                    }
                    if (discoveryResult.userTweetsQueryId) {
                        graphqlParams.userTweetsQueryId = discoveryResult.userTweetsQueryId;
                        console.log(`✓ UserTweets queryId: ${discoveryResult.userTweetsQueryId}`);
                    }
                    if (discoveryResult.userTweetsAndRepliesQueryId) {
                        graphqlParams.userTweetsAndRepliesQueryId = discoveryResult.userTweetsAndRepliesQueryId;
                        console.log(`✓ UserTweetsAndReplies queryId: ${discoveryResult.userTweetsAndRepliesQueryId}`);
                    }
                    if (discoveryResult.features) {
                        graphqlParams.features = discoveryResult.features;
                        console.log(`✓ 动态发现 features (${Object.keys(discoveryResult.features).length} 项)`);
                    }
                    
                    // 保存缓存
                    if (graphqlParams.userByScreenNameQueryId && graphqlParams.userTweetsQueryId) {
                        await saveGraphQLCache(cacheKey, graphqlParams);
                    }
                }
            } catch (e) {
                console.warn(`⚠ 动态发现失败: ${e.message}`);
            }
        }
        
        if (!graphqlParams.userByScreenNameQueryId) {
            console.error('✗ 无法发现 UserByScreenName queryId，请确保已登录 X.com 并正常加载了用户主页');
            process.exit(1);
        }

        // ================================================================
        // Phase 3: 获取用户信息（UserByScreenName）
        // ================================================================
        console.log('\n[Phase 3] 获取用户信息...');
        
        const userInfoResult = await retryWithBackoff(
            async () => {
                return await safeExecuteScript(
                    tabId,
                    buildUserByScreenNameScript(username, graphqlParams.userByScreenNameQueryId, graphqlParams.features),
                    { timeout: 60 }
                );
            },
            {
                maxRetries: 3,
                baseDelay: 2000,
                onRetry: (attempt, delay, reason) => {
                    console.log(`  重试 #${attempt}（等待 ${Math.round(delay / 1000)}s）: ${reason?.error || reason?.message || '未知'}`);
                }
            }
        );
        
        if (!userInfoResult || !userInfoResult.success) {
            console.error(`✗ 获取用户信息失败: ${userInfoResult?.error || '未知错误'}`);
            process.exit(1);
        }
        
        const userId = userInfoResult.userId;
        userProfile = userInfoResult.profile;
        
        console.log(`✓ 用户: ${userProfile.name} (@${userProfile.screenName})`);
        console.log(`  粉丝: ${userProfile.followersCount.toLocaleString()} | 关注: ${userProfile.followingCount.toLocaleString()}`);
        console.log(`  推文总数: ${userProfile.tweetCount.toLocaleString()}`);
        if (userProfile.isProtected) {
            console.warn('⚠ 该用户已设为私密，可能无法获取推文');
        }

        // ================================================================
        // Phase 4: UserTweets API 循环翻页
        // ================================================================
        let tweetsQueryId = options.includeReplies
            ? (graphqlParams.userTweetsAndRepliesQueryId || graphqlParams.userTweetsQueryId)
            : graphqlParams.userTweetsQueryId;
        
        if (!tweetsQueryId) {
            console.error('✗ 无法发现 UserTweets queryId');
            process.exit(1);
        }
        
        const apiName = options.includeReplies ? 'UserTweetsAndReplies' : 'UserTweets';
        console.log(`\n[Phase 4] 使用 ${apiName} API 循环翻页...`);
        
        let graphqlFailed = false;
        let cursor = null;
        let hitSinceLimit = false;
        let cacheInvalidated = false; // 是否已触发过一次缓存失效重新发现
        
        for (let page = 1; page <= options.maxPages; page++) {
            console.log(`正在获取第 ${page}/${options.maxPages} 页...`);
            
            const startTime = Date.now();
            
            const graphqlResult = await retryWithBackoff(
                async () => {
                    return await safeExecuteScript(
                        tabId,
                        buildUserTweetsScript(userId, cursor, tweetsQueryId, graphqlParams.features, options.includeReplies),
                        { timeout: 30 }
                    );
                },
                {
                    maxRetries: 3,
                    baseDelay: 3000,
                    maxDelay: 30000,
                    onRetry: (attempt, delay, reason) => {
                        const errMsg = reason?.error || reason?.message || '未知';
                        console.log(`  重试 #${attempt}（等待 ${Math.round(delay / 1000)}s）: ${errMsg}`);
                    }
                }
            );
            
            const elapsed = Date.now() - startTime;
            
            // 处理失败
            if (!graphqlResult || !graphqlResult.success) {
                const errMsg = graphqlResult?.error || '未知错误';
                const statusCode = graphqlResult?.statusCode;
                
                // 400 错误可能是 queryId 过期，尝试清除缓存重新发现一次
                if (statusCode === 400 && !cacheInvalidated) {
                    cacheInvalidated = true;
                    console.warn('⚠ API 返回 400，queryId 可能已过期，清除缓存并重新发现...');
                    await clearGraphQLCache(cacheKey);
                    
                    try {
                        const rediscovery = await safeExecuteScript(
                            tabId,
                            buildDiscoverUserQueryIdsScript(),
                            { timeout: 60 }
                        );
                        if (rediscovery?.success) {
                            const newTweetsQueryId = options.includeReplies
                                ? (rediscovery.userTweetsAndRepliesQueryId || rediscovery.userTweetsQueryId)
                                : rediscovery.userTweetsQueryId;
                            if (newTweetsQueryId) {
                                graphqlParams.userTweetsQueryId = rediscovery.userTweetsQueryId || graphqlParams.userTweetsQueryId;
                                graphqlParams.userTweetsAndRepliesQueryId = rediscovery.userTweetsAndRepliesQueryId || graphqlParams.userTweetsAndRepliesQueryId;
                                graphqlParams.userByScreenNameQueryId = rediscovery.userByScreenNameQueryId || graphqlParams.userByScreenNameQueryId;
                                graphqlParams.features = rediscovery.features || graphqlParams.features;
                                tweetsQueryId = newTweetsQueryId;
                                await saveGraphQLCache(cacheKey, graphqlParams);
                                console.log(`✓ 重新发现 queryId: ${newTweetsQueryId}，重试当前页...`);
                                page--;
                                continue;
                            }
                        }
                    } catch (e) {
                        console.warn(`⚠ 重新发现失败: ${e.message}`);
                    }
                }
                
                // 连续 429 保护
                if (statusCode === 429) {
                    consecutive429Count++;
                    console.warn(`⚠ 遇到速率限制 (429)，连续 ${consecutive429Count} 次`);
                    
                    if (consecutive429Count >= MAX_CONSECUTIVE_429) {
                        console.log(`连续 ${MAX_CONSECUTIVE_429} 次 429，暂停 5 分钟后继续...`);
                        
                        // 保存当前进度
                        await saveProgress(outputDir, buildStateObject(options, username, userId, userProfile, cursor, page - 1, allTweets, seenIds, graphqlParams, outputPath));
                        
                        await new Promise(resolve => setTimeout(resolve, LONG_PAUSE_MS));
                        consecutive429Count = 0;
                        page--; // 重试当前页
                        continue;
                    }
                } else {
                    console.warn(`⚠ GraphQL API 调用失败 (第 ${page} 页): ${errMsg}`);
                    if (page === 1) graphqlFailed = true;
                    break;
                }
            } else {
                consecutive429Count = 0; // 成功则重置计数
            }
            
            if (!graphqlResult || !graphqlResult.success) {
                // 429 重试后仍失败
                if (page === 1) graphqlFailed = true;
                break;
            }
            
            const { tweets: pageTweets, nextCursor } = graphqlResult;
            
            if (Array.isArray(pageTweets) && pageTweets.length > 0) {
                // 过滤推文
                const { filtered, hitSinceLimit: hitLimit } = filterTweets(pageTweets, options);
                hitSinceLimit = hitLimit;
                
                let newCount = 0;
                const newTweets = [];
                filtered.forEach(tweet => {
                    if (!seenIds.has(tweet.tweetId)) {
                        seenIds.add(tweet.tweetId);
                        allTweets.push(tweet);
                        newTweets.push(tweet);
                        newCount++;
                    }
                });
                
                const skipped = pageTweets.length - filtered.length;
                const skipInfo = skipped > 0 ? ` (${skipped} 条被过滤)` : '';
                console.log(`✓ 第 ${page} 页获取 ${pageTweets.length} 条推文, ${newCount} 条新增${skipInfo}, 累计 ${allTweets.length} 条`);
                
                // 增量保存
                await appendPartialTweets(outputDir, newTweets);
                await saveProgress(outputDir, buildStateObject(options, username, userId, userProfile, nextCursor, page, allTweets, seenIds, graphqlParams, outputPath));
                
                // 检查 --since 提前终止
                if (hitSinceLimit) {
                    console.log(`已到达 since 日期 (${options.since})，停止翻页`);
                    break;
                }
                
                // 检查 --max-tweets 上限
                if (options.maxTweets > 0 && allTweets.length >= options.maxTweets) {
                    console.log(`已达到最大推文数 (${options.maxTweets})，停止翻页`);
                    break;
                }
            } else {
                console.log(`第 ${page} 页无更多结果，停止翻页`);
                break;
            }
            
            if (nextCursor) {
                cursor = nextCursor;
            } else {
                console.log('无更多分页游标，停止翻页');
                break;
            }
            
            // 自适应翻页间隔
            if (page < options.maxPages) {
                if (elapsed > 8000) {
                    pageDelay = Math.min(pageDelay * 1.5, MAX_PAGE_DELAY);
                } else if (elapsed < 3000) {
                    pageDelay = Math.max(pageDelay * 0.9, MIN_PAGE_DELAY);
                }
                console.log(`等待 ${(pageDelay / 1000).toFixed(1)} 秒...`);
                await new Promise(resolve => setTimeout(resolve, pageDelay));
            }
        }

        // ================================================================
        // Phase 5: DOM 回退（如果 GraphQL 首页就失败且无结果）
        // ================================================================
        if (graphqlFailed && allTweets.length === 0) {
            console.log('\n[Phase 5] GraphQL 失败，回退到 DOM 提取...');
            
            const domResult = await safeExecuteScript(tabId, buildProfileDomScript(), { timeout: 60 });
            
            if (domResult?.success && domResult.tweets?.length > 0) {
                const { filtered } = filterTweets(domResult.tweets, options);
                const newTweets = [];
                filtered.forEach(tweet => {
                    if (!seenIds.has(tweet.tweetId)) {
                        seenIds.add(tweet.tweetId);
                        allTweets.push(tweet);
                        newTweets.push(tweet);
                    }
                });
                console.log(`✓ DOM 回退获取到 ${domResult.tweetCount} 条推文 (过滤后 ${newTweets.length} 条)`);
                await appendPartialTweets(outputDir, newTweets);
            } else {
                const errMsg = domResult?.error || 'DOM 未提取到推文';
                console.warn(`⚠ DOM 回退也失败: ${errMsg}`);
            }
        }

        // ================================================================
        // 释放标签页
        // ================================================================
        await releaseXTab(browser, tabId, !options.closeTab);

        // ================================================================
        // 应用最终过滤并保存结果
        // ================================================================
        let filteredTweets = allTweets;
        
        // 应用最低互动数过滤
        if (options.minLikes > 0 || options.minRetweets > 0) {
            filteredTweets = allTweets.filter(t =>
                t.stats.likes >= options.minLikes &&
                t.stats.retweets >= options.minRetweets
            );
            if (filteredTweets.length < allTweets.length) {
                console.log(`\n已过滤不满足互动数条件的推文: ${allTweets.length} → ${filteredTweets.length}`);
            }
        }
        
        // 应用 --max-tweets 截断
        if (options.maxTweets > 0 && filteredTweets.length > options.maxTweets) {
            filteredTweets = filteredTweets.slice(0, options.maxTweets);
            console.log(`已截断到 ${options.maxTweets} 条推文`);
        }

        // 构建结果对象
        const result = {
            username: username,
            profile: userProfile,
            scrapeOptions: {
                maxPages: options.maxPages,
                maxTweets: options.maxTweets,
                since: options.since,
                until: options.until,
                includeReplies: options.includeReplies,
                includeRetweets: options.includeRetweets,
                minLikes: options.minLikes,
                minRetweets: options.minRetweets
            },
            timestamp: new Date().toISOString(),
            totalResults: filteredTweets.length,
            results: filteredTweets
        };

        const output = options.pretty
            ? JSON.stringify(result, null, 2)
            : JSON.stringify(result);
        
        await saveToFile(outputPath, output);
        await cleanupTempFiles(outputDir);
        printSummary(filteredTweets, '抓取完成');

    } catch (error) {
        console.error('\n✗ 抓取失败:');
        console.error(error.message);
        if (error.stack) {
            console.error('\n堆栈跟踪:');
            console.error(error.stack);
        }
        
        // 释放标签页
        if (tabId) {
            try { await releaseXTab(browser, tabId, !options.closeTab); } catch (e) {}
        } else {
            browser.disconnect();
        }
        
        process.exit(1);
    }
}

// ============================================================================
// 断点续传 state 构建
// ============================================================================

function buildStateObject(options, username, userId, userProfile, cursor, currentPage, allTweets, seenIds, graphqlParams, outputPath) {
    return {
        type: 'x_profile',
        username,
        userId,
        userProfile,
        cursor,
        currentPage,
        totalCollected: allTweets.length,
        seenIds: [...seenIds],
        options: {
            maxPages: options.maxPages,
            maxTweets: options.maxTweets,
            since: options.since,
            until: options.until,
            includeReplies: options.includeReplies,
            includeRetweets: options.includeRetweets,
            minLikes: options.minLikes,
            minRetweets: options.minRetweets
        },
        graphqlParams,
        outputPath,
        updatedAt: new Date().toISOString()
    };
}

// ============================================================================
// 恢复抓取（从中断处继续）
// ============================================================================

async function resumeProfile(options) {
    let resumeDir = options.resume;
    if (!path.isAbsolute(resumeDir)) {
        resumeDir = path.join(process.cwd(), resumeDir);
    }
    
    const state = await loadProgress(resumeDir);
    if (!state) {
        console.error(`错误: 在 ${resumeDir} 中未找到可恢复的抓取进度 (state.json)`);
        process.exit(1);
    }
    
    if (state.type !== 'x_profile') {
        console.error(`错误: state.json 类型不匹配（期望 x_profile，实际 ${state.type || '未知'}）`);
        process.exit(1);
    }
    
    console.log('='.repeat(60));
    console.log('X.com 用户帖子抓取工具 - 恢复模式');
    console.log('='.repeat(60));
    console.log(`用户名: @${state.username}`);
    console.log(`已获取: ${state.totalCollected} 条推文`);
    console.log(`上次停止: 第 ${state.currentPage} 页`);
    console.log(`目标页数: ${state.options.maxPages}`);
    console.log('='.repeat(60));
    
    // 恢复已有数据
    const partialTweets = await loadPartialTweets(resumeDir);
    const allTweets = [...partialTweets];
    const seenIds = new Set(state.seenIds || partialTweets.map(t => t.tweetId));
    
    console.log(`✓ 已恢复 ${allTweets.length} 条推文`);
    
    if (!state.cursor) {
        console.log('无更多分页游标，抓取已完成');
    } else if (state.currentPage >= state.options.maxPages) {
        console.log('已达到最大页数限制，抓取已完成');
    } else if (state.options.maxTweets > 0 && allTweets.length >= state.options.maxTweets) {
        console.log('已达到最大推文数，抓取已完成');
    } else {
        // 继续抓取
        const mergedOptions = { ...options, ...state.options };
        const profileUrl = `https://x.com/${state.username}`;
        
        const browser = new BrowserAutomation(mergedOptions.browserServer || options.browserServer);
        const safeExecuteScript = createSafeExecuteScript(browser);
        let tabId = null;
        
        let pageDelay = 3000;
        const MIN_PAGE_DELAY = 3000;
        const MAX_PAGE_DELAY = 8000;
        let consecutive429Count = 0;
        const MAX_CONSECUTIVE_429 = 3;
        const LONG_PAUSE_MS = 5 * 60 * 1000;
        
        try {
            console.log('\n获取浏览器标签页...');
            const tabResult = await acquireXTab(browser, profileUrl);
            tabId = tabResult.tabId;
            
            if (!tabResult.isReused || tabResult.navigated) {
                try {
                    await waitForPageLoad(browser, tabId, { timeout: 30000 });
                } catch (e) {
                    console.warn('⚠ 等待页面加载超时，继续执行');
                }
            }
            const renderWait = tabResult.isReused && !tabResult.navigated ? 1000 : 4000;
            await new Promise(resolve => setTimeout(resolve, renderWait));
            
            let cursor = state.cursor;
            const startPage = state.currentPage + 1;
            const gp = state.graphqlParams || {};
            
            const tweetsQueryId = mergedOptions.includeReplies
                ? (gp.userTweetsAndRepliesQueryId || gp.userTweetsQueryId)
                : gp.userTweetsQueryId;
            
            if (!tweetsQueryId) {
                console.error('✗ state.json 中缺少 UserTweets queryId，无法恢复');
                process.exit(1);
            }
            
            for (let page = startPage; page <= state.options.maxPages; page++) {
                console.log(`正在获取第 ${page}/${state.options.maxPages} 页...`);
                
                const startTime = Date.now();
                
                const graphqlResult = await retryWithBackoff(
                    async () => {
                        return await safeExecuteScript(
                            tabId,
                            buildUserTweetsScript(state.userId, cursor, tweetsQueryId, gp.features, mergedOptions.includeReplies),
                            { timeout: 30 }
                        );
                    },
                    {
                        maxRetries: 3,
                        baseDelay: 3000,
                        maxDelay: 30000,
                        onRetry: (attempt, delay, reason) => {
                            const errMsg = reason?.error || reason?.message || '未知';
                            console.log(`  重试 #${attempt}（等待 ${Math.round(delay / 1000)}s）: ${errMsg}`);
                        }
                    }
                );
                
                const elapsed = Date.now() - startTime;
                
                if (!graphqlResult || !graphqlResult.success) {
                    const statusCode = graphqlResult?.statusCode;
                    
                    if (statusCode === 429) {
                        consecutive429Count++;
                        console.warn(`⚠ 遇到速率限制 (429)，连续 ${consecutive429Count} 次`);
                        
                        if (consecutive429Count >= MAX_CONSECUTIVE_429) {
                            console.log(`连续 ${MAX_CONSECUTIVE_429} 次 429，暂停 5 分钟后继续...`);
                            await saveProgress(resumeDir, {
                                ...state,
                                cursor,
                                currentPage: page - 1,
                                totalCollected: allTweets.length,
                                seenIds: [...seenIds],
                                updatedAt: new Date().toISOString()
                            });
                            await new Promise(resolve => setTimeout(resolve, LONG_PAUSE_MS));
                            consecutive429Count = 0;
                            page--;
                            continue;
                        }
                    } else {
                        console.warn(`⚠ GraphQL API 调用失败 (第 ${page} 页): ${graphqlResult?.error || '未知错误'}`);
                        break;
                    }
                }
                
                if (!graphqlResult || !graphqlResult.success) {
                    break;
                }
                
                consecutive429Count = 0;
                const { tweets: pageTweets, nextCursor } = graphqlResult;
                
                if (Array.isArray(pageTweets) && pageTweets.length > 0) {
                    const { filtered, hitSinceLimit } = filterTweets(pageTweets, mergedOptions);
                    
                    let newCount = 0;
                    const newTweets = [];
                    filtered.forEach(tweet => {
                        if (!seenIds.has(tweet.tweetId)) {
                            seenIds.add(tweet.tweetId);
                            allTweets.push(tweet);
                            newTweets.push(tweet);
                            newCount++;
                        }
                    });
                    
                    const skipped = pageTweets.length - filtered.length;
                    const skipInfo = skipped > 0 ? ` (${skipped} 条被过滤)` : '';
                    console.log(`✓ 第 ${page} 页获取 ${pageTweets.length} 条推文, ${newCount} 条新增${skipInfo}, 累计 ${allTweets.length} 条`);
                    
                    await appendPartialTweets(resumeDir, newTweets);
                    await saveProgress(resumeDir, {
                        ...state,
                        cursor: nextCursor,
                        currentPage: page,
                        totalCollected: allTweets.length,
                        seenIds: [...seenIds],
                        updatedAt: new Date().toISOString()
                    });
                    
                    if (hitSinceLimit) {
                        console.log(`已到达 since 日期 (${mergedOptions.since})，停止翻页`);
                        break;
                    }
                    
                    if (mergedOptions.maxTweets > 0 && allTweets.length >= mergedOptions.maxTweets) {
                        console.log(`已达到最大推文数 (${mergedOptions.maxTweets})，停止翻页`);
                        break;
                    }
                } else {
                    console.log(`第 ${page} 页无更多结果，停止翻页`);
                    break;
                }
                
                if (nextCursor) {
                    cursor = nextCursor;
                } else {
                    console.log('无更多分页游标，停止翻页');
                    break;
                }
                
                if (page < state.options.maxPages) {
                    if (elapsed > 8000) {
                        pageDelay = Math.min(pageDelay * 1.5, MAX_PAGE_DELAY);
                    } else if (elapsed < 3000) {
                        pageDelay = Math.max(pageDelay * 0.9, MIN_PAGE_DELAY);
                    }
                    console.log(`等待 ${(pageDelay / 1000).toFixed(1)} 秒...`);
                    await new Promise(resolve => setTimeout(resolve, pageDelay));
                }
            }
            
            // 释放标签页
            await releaseXTab(browser, tabId, !options.closeTab);
        } catch (error) {
            console.error('\n✗ 恢复抓取失败:', error.message);
            if (tabId) {
                try { await releaseXTab(browser, tabId, !options.closeTab); } catch (e) {}
            } else {
                browser.disconnect();
            }
            process.exit(1);
        }
    }
    
    // 应用过滤并保存最终结果
    let filteredTweets = allTweets;
    const opts = state.options;
    
    if ((opts.minLikes || 0) > 0 || (opts.minRetweets || 0) > 0) {
        filteredTweets = allTweets.filter(t =>
            t.stats.likes >= (opts.minLikes || 0) &&
            t.stats.retweets >= (opts.minRetweets || 0)
        );
        if (filteredTweets.length < allTweets.length) {
            console.log(`\n已过滤不满足互动数条件的推文: ${allTweets.length} → ${filteredTweets.length}`);
        }
    }
    
    if ((opts.maxTweets || 0) > 0 && filteredTweets.length > opts.maxTweets) {
        filteredTweets = filteredTweets.slice(0, opts.maxTweets);
    }
    
    const outputPath = state.outputPath || path.join(resumeDir, 'data.json');
    const result = {
        username: state.username,
        profile: state.userProfile,
        scrapeOptions: state.options,
        timestamp: new Date().toISOString(),
        totalResults: filteredTweets.length,
        results: filteredTweets
    };
    
    const output = options.pretty
        ? JSON.stringify(result, null, 2)
        : JSON.stringify(result);
    
    await saveToFile(outputPath, output);
    await cleanupTempFiles(resumeDir);
    printSummary(filteredTweets, '抓取完成');
}

// 运行主函数
if (require.main === module) {
    main().catch(error => {
        console.error('未处理的错误:', error);
        process.exit(1);
    });
}

module.exports = {
    main,
    parseArgs,
    buildDiscoverUserQueryIdsScript,
    buildUserByScreenNameScript,
    buildUserTweetsScript,
    buildProfileDomScript,
    filterTweets
};
