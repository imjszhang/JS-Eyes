#!/usr/bin/env node

/**
 * X.com (Twitter) 首页推荐内容抓取脚本
 * 使用 GraphQL HomeTimeline / HomeLatestTimeline API 抓取首页推荐流
 * 
 * 使用方法:
 *   node scripts/x-home.js [options]
 * 
 * 选项:
 *   --feed <type>              Feed 类型: foryou(默认) / following
 *   --max-pages <number>       最多翻页数（默认5，每页约20条）
 *   --max-tweets <number>      最多抓取推文数（达到后停止）
 *   --min-likes <number>       最低点赞过滤（默认0）
 *   --min-retweets <number>    最低转发过滤（默认0）
 *   --exclude-replies          排除回复
 *   --exclude-retweets         排除转推
 *   --pretty                   美化 JSON 输出
 *   --browser-server <url>     JS-Eyes WebSocket 服务器地址（默认 ws://localhost:18080）
 *   --output <file>            指定输出文件路径
 *   --close-tab                抓完后关闭 tab（默认保留供下次复用）
 *   --resume <dir>             从中断的抓取目录恢复继续
 * 
 * 文件保存位置:
 *   work_dir/scrape/x_com_home/{feed}_{timestamp}/data.json
 * 
 * 示例:
 *   node scripts/x-home.js
 *   node scripts/x-home.js --feed following --max-pages 10
 *   node scripts/x-home.js --min-likes 100 --pretty
 *   node scripts/x-home.js --exclude-replies --exclude-retweets
 *   node scripts/x-home.js --max-tweets 200 --close-tab
 *   node scripts/x-home.js --resume work_dir/scrape/x_com_home/foryou_2026-02-12T10-00-00
 * 
 * 注意:
 *   - 需要 JS-Eyes Server 运行中，且浏览器已安装 JS-Eyes 扩展并登录 X.com
 *   - X.com 需要登录状态才能访问首页推荐流
 *   - 默认不关闭 tab，下次运行可秒级复用已有的 x.com 标签页
 */

const { BrowserAutomation } = require('../lib/js-eyes-client');
const path = require('path');
const { getHomeFeed } = require('../lib/api');
const {
    DEFAULT_GRAPHQL_FEATURES,
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
        feed: 'foryou',       // foryou / following
        maxPages: 5,
        maxTweets: 0,          // 0 = 不限制
        pretty: false,
        browserServer: null,
        output: null,
        minLikes: 0,
        minRetweets: 0,
        excludeReplies: false,
        excludeRetweets: false,
        closeTab: false,
        resume: null
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg.startsWith('--')) {
            const key = arg.replace('--', '').replace(/-/g, '');
            const nextArg = args[i + 1];

            switch (key) {
                case 'feed':
                    options.feed = nextArg || 'foryou';
                    i++;
                    break;
                case 'maxpages':
                    options.maxPages = parseInt(nextArg, 10) || 5;
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
                case 'excludereplies':
                    options.excludeReplies = true;
                    break;
                case 'excluderetweets':
                    options.excludeRetweets = true;
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
        }
    }

    return options;
}

function printUsage() {
    console.log('\n使用方法:');
    console.log('  node scripts/x-home.js [options]');
    console.log('\n选项:');
    console.log('  --feed <type>              Feed 类型: foryou(默认) / following');
    console.log('  --max-pages <number>       最多翻页数（默认5，每页约20条）');
    console.log('  --max-tweets <number>      最多抓取推文数（达到后停止）');
    console.log('  --min-likes <number>       最低点赞过滤（默认0）');
    console.log('  --min-retweets <number>    最低转发过滤（默认0）');
    console.log('  --exclude-replies          排除回复');
    console.log('  --exclude-retweets         排除转推');
    console.log('  --pretty                   美化 JSON 输出');
    console.log('  --browser-server <url>     浏览器服务器地址');
    console.log('  --output <file>            指定输出文件路径');
    console.log('  --close-tab                抓完后关闭 tab（默认保留）');
    console.log('  --resume <dir>             从中断的抓取目录恢复继续');
    console.log('\n示例:');
    console.log('  node scripts/x-home.js');
    console.log('  node scripts/x-home.js --feed following --max-pages 10');
    console.log('  node scripts/x-home.js --min-likes 100 --pretty');
    console.log('  node scripts/x-home.js --exclude-replies --exclude-retweets');
    console.log('  node scripts/x-home.js --max-tweets 200 --close-tab');
    console.log('  node scripts/x-home.js --resume work_dir/scrape/x_com_home/foryou_2026-02-12T10-00-00');
}

// ============================================================================
// GraphQL queryId 发现脚本
// ============================================================================

/**
 * 生成动态发现 HomeTimeline 和 HomeLatestTimeline queryId 的浏览器端脚本
 * 
 * 发现策略：
 * 1. 从 performance.getEntriesByType('resource') 匹配已有请求
 * 2. 回退到扫描 JS bundle
 */
function buildDiscoverHomeQueryIdsScript() {
    return `
    (async () => {
        try {
            const result = {
                homeTimelineQueryId: null,
                homeLatestTimelineQueryId: null,
                features: null,
                variables: null
            };
            
            // 从 URL 中提取 queryId、features 和 variables
            const parseGraphQLUrl = (urlStr) => {
                const parsed = {};
                try {
                    const url = new URL(urlStr);
                    const fp = url.searchParams.get('features');
                    if (fp) parsed.features = JSON.parse(fp);
                    const vp = url.searchParams.get('variables');
                    if (vp) parsed.variables = JSON.parse(vp);
                } catch (e) {}
                return parsed;
            };
            
            // 策略 1: 从 performance API 中匹配
            try {
                const resources = performance.getEntriesByType('resource');
                for (const r of resources) {
                    if (!result.homeTimelineQueryId) {
                        // 匹配 HomeTimeline 但不匹配 HomeLatestTimeline
                        const m = r.name.match(/graphql\\/([A-Za-z0-9_-]+)\\/HomeTimeline(?!Latest)/);
                        if (m) {
                            result.homeTimelineQueryId = m[1];
                            const parsed = parseGraphQLUrl(r.name);
                            if (parsed.features && !result.features) result.features = parsed.features;
                            if (parsed.variables && !result.variables) result.variables = parsed.variables;
                        }
                    }
                    if (!result.homeLatestTimelineQueryId) {
                        const m = r.name.match(/graphql\\/([A-Za-z0-9_-]+)\\/HomeLatestTimeline/);
                        if (m) {
                            result.homeLatestTimelineQueryId = m[1];
                            const parsed = parseGraphQLUrl(r.name);
                            if (parsed.features && !result.features) result.features = parsed.features;
                            if (parsed.variables && !result.variables) result.variables = parsed.variables;
                        }
                    }
                }
            } catch (e) {}
            
            // 策略 2: 从 JS bundle 中搜索
            if (!result.homeTimelineQueryId || !result.homeLatestTimelineQueryId) {
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
                            
                            if (!result.homeTimelineQueryId) {
                                const m = text.match(/queryId:"([A-Za-z0-9_-]+)",operationName:"HomeTimeline"/);
                                if (m) result.homeTimelineQueryId = m[1];
                            }
                            if (!result.homeLatestTimelineQueryId) {
                                const m = text.match(/queryId:"([A-Za-z0-9_-]+)",operationName:"HomeLatestTimeline"/);
                                if (m) result.homeLatestTimelineQueryId = m[1];
                            }
                            
                            if (result.homeTimelineQueryId && result.homeLatestTimelineQueryId) break;
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
// HomeTimeline GraphQL 脚本
// ============================================================================

/**
 * 生成 HomeTimeline / HomeLatestTimeline GraphQL API 调用脚本
 * 
 * @param {string} cursor - 分页游标（首页为 null）
 * @param {string} queryId - 动态发现的 queryId
 * @param {Object} [features] - 动态发现的 features
 * @param {string} [operationName='HomeTimeline'] - 操作名称
 * @param {Object} [variablesTemplate] - 从实际请求捕获的 variables 模板
 * @returns {string} JS 代码字符串
 */
function buildHomeTimelineScript(cursor, queryId, features, operationName = 'HomeTimeline', variablesTemplate = null) {
    const safeCursor = (cursor || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
    const featuresToUse = features || DEFAULT_GRAPHQL_FEATURES;
    const featuresLiteral = JSON.stringify(featuresToUse);
    // 使用捕获的 variables 模板，或回退到最小必需字段
    const variablesTemplateLiteral = variablesTemplate ? JSON.stringify(variablesTemplate) : 'null';
    
    return `
    (async () => {
        try {
            const ct0 = document.cookie.match(/ct0=([^;]+)/)?.[1];
            if (!ct0) {
                return { success: false, error: '未找到 ct0 cookie，请确保已登录 X.com' };
            }
            
            ${buildGraphQLTweetParserSnippet()}
            
            // 优先使用从实际请求捕获的 variables 模板
            const capturedTemplate = ${variablesTemplateLiteral};
            let variables;
            if (capturedTemplate) {
                variables = { ...capturedTemplate };
                // 移除旧 cursor，后面会设置新的
                delete variables.cursor;
            } else {
                // 回退：尝试从当前页面的 performance API 获取实际 variables
                let liveVariables = null;
                try {
                    const resources = performance.getEntriesByType('resource');
                    for (const r of resources) {
                        if (r.name.includes('/${operationName}')) {
                            const url = new URL(r.name);
                            const vp = url.searchParams.get('variables');
                            if (vp) {
                                liveVariables = JSON.parse(vp);
                                break;
                            }
                        }
                    }
                } catch (e) {}
                
                if (liveVariables) {
                    variables = { ...liveVariables };
                    delete variables.cursor;
                } else {
                    // 最后回退：最小字段集
                    variables = {
                        count: 20,
                        includePromotedContent: true,
                        latestControlAvailable: true,
                        requestContext: 'launch',
                        withCommunity: true
                    };
                }
            }
            
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
                // 兼容多种可能的响应路径
                const timeline = data?.data?.home?.home_timeline_urt
                    || data?.data?.home_timeline?.timeline
                    || data?.data?.home?.home_timeline?.timeline;
                
                if (!timeline) {
                    return { success: false, error: '无法定位 timeline 数据结构', raw: JSON.stringify(data).substring(0, 500) };
                }
                
                const instructions = timeline.instructions || [];
                
                // 从 instructions 中提取所有 entries
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
// DOM 回退脚本（首页）
// ============================================================================

/**
 * 生成首页 DOM 滚动提取脚本（回退方案）
 * 在首页滚动并提取可见推文
 */
function buildHomeDomScript() {
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
                return { success: false, error: '未检测到推文，可能未登录或页面加载异常', tweets: [] };
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

/**
 * 过滤推文
 * @param {Array} tweets - 原始推文数组
 * @param {Object} options - 过滤选项
 * @returns {Array} 过滤后的推文数组
 */
function filterTweets(tweets, options) {
    return tweets.filter(tweet => {
        // 排除回复
        if (options.excludeReplies && tweet.isReply) return false;
        // 排除转推
        if (options.excludeRetweets && tweet.isRetweet) return false;
        return true;
    });
}

/**
 * 获取 feed 对应的 API 操作名称
 * @param {string} feed - 'foryou' 或 'following'
 * @returns {string} GraphQL 操作名称
 */
function feedToOperationName(feed) {
    return feed === 'following' ? 'HomeLatestTimeline' : 'HomeTimeline';
}

/**
 * 获取 feed 对应的 queryId 缓存键名
 * @param {string} feed - 'foryou' 或 'following'
 * @returns {string} 缓存键名
 */
function feedToCacheKey(feed) {
    return feed === 'following' ? 'HomeLatestTimeline' : 'HomeTimeline';
}

// ============================================================================
// 主流程
// ============================================================================

async function main() {
    const options = parseArgs();

    if (options.resume) {
        return await resumeHome(options);
    }

    if (!['foryou', 'following'].includes(options.feed)) {
        console.error(`错误: 无效的 feed 类型 "${options.feed}"，可选: foryou / following`);
        printUsage();
        process.exit(1);
    }

    const operationName = feedToOperationName(options.feed);

    let outputPath = options.output;
    let outputDir;
    if (!outputPath) {
        const timestamp = generateTimestamp();
        const dirName = `${options.feed}_${timestamp}`;
        outputDir = path.join(process.cwd(), 'work_dir', 'scrape', 'x_com_home', dirName);
        outputPath = path.join(outputDir, 'data.json');
    } else {
        if (!path.isAbsolute(outputPath)) {
            outputPath = path.join(process.cwd(), 'work_dir', 'scrape', 'x_com_home', outputPath);
        }
        outputDir = path.dirname(outputPath);
    }

    console.log('='.repeat(60));
    console.log('X.com 首页推荐内容抓取工具');
    console.log('='.repeat(60));
    console.log(`Feed 类型: ${options.feed} (${operationName})`);
    console.log(`最多页数: ${options.maxPages}`);
    if (options.maxTweets > 0) console.log(`最多推文数: ${options.maxTweets}`);
    if (options.minLikes > 0) console.log(`最低点赞: ${options.minLikes}`);
    if (options.minRetweets > 0) console.log(`最低转发: ${options.minRetweets}`);
    if (options.excludeReplies) console.log('排除回复: 是');
    if (options.excludeRetweets) console.log('排除转推: 是');
    console.log(`关闭 Tab: ${options.closeTab ? '是' : '否（保留复用）'}`);
    console.log(`输出文件: ${outputPath}`);
    console.log('='.repeat(60));

    const browser = new BrowserAutomation(options.browserServer);

    try {
        const result = await getHomeFeed(browser, {
            ...options,
            logger: console,
            _outputDir: outputDir,
        });

        const output = options.pretty
            ? JSON.stringify(result, null, 2)
            : JSON.stringify(result);
        await saveToFile(outputPath, output);
        await cleanupTempFiles(outputDir);
        printSummary(result.results, '抓取完成');

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

// ============================================================================
// 断点续传 state 构建
// ============================================================================

function buildStateObject(options, cursor, currentPage, allTweets, seenIds, graphqlParams, outputPath) {
    return {
        type: 'x_home',
        feed: options.feed,
        cursor,
        currentPage,
        totalCollected: allTweets.length,
        seenIds: [...seenIds],
        options: {
            feed: options.feed,
            maxPages: options.maxPages,
            maxTweets: options.maxTweets,
            minLikes: options.minLikes,
            minRetweets: options.minRetweets,
            excludeReplies: options.excludeReplies,
            excludeRetweets: options.excludeRetweets
        },
        graphqlParams,
        outputPath,
        updatedAt: new Date().toISOString()
    };
}

// ============================================================================
// 恢复抓取（从中断处继续）
// ============================================================================

async function resumeHome(options) {
    let resumeDir = options.resume;
    if (!path.isAbsolute(resumeDir)) {
        resumeDir = path.join(process.cwd(), resumeDir);
    }
    
    const state = await loadProgress(resumeDir);
    if (!state) {
        console.error(`错误: 在 ${resumeDir} 中未找到可恢复的抓取进度 (state.json)`);
        process.exit(1);
    }
    
    if (state.type !== 'x_home') {
        console.error(`错误: state.json 类型不匹配（期望 x_home，实际 ${state.type || '未知'}）`);
        process.exit(1);
    }
    
    const operationName = feedToOperationName(state.feed);
    
    console.log('='.repeat(60));
    console.log('X.com 首页推荐内容抓取工具 - 恢复模式');
    console.log('='.repeat(60));
    console.log(`Feed 类型: ${state.feed} (${operationName})`);
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
        const homeUrl = 'https://x.com/home';
        
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
            const tabResult = await acquireXTab(browser, homeUrl);
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
            
            const queryId = gp.queryId
                || (state.feed === 'following' ? gp.homeLatestTimelineQueryId : gp.homeTimelineQueryId)
                || gp.homeTimelineQueryId;
            
            if (!queryId) {
                console.error('✗ state.json 中缺少 queryId，无法恢复');
                process.exit(1);
            }
            
            for (let page = startPage; page <= state.options.maxPages; page++) {
                console.log(`正在获取第 ${page}/${state.options.maxPages} 页...`);
                
                const startTime = Date.now();
                
                const graphqlResult = await retryWithBackoff(
                    async () => {
                        return await safeExecuteScript(
                            tabId,
                            buildHomeTimelineScript(cursor, queryId, gp.features, operationName, gp.variables),
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
                    const filtered = filterTweets(pageTweets, mergedOptions);
                    
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
        feed: state.feed,
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

module.exports = {
    main,
    parseArgs,
    buildDiscoverHomeQueryIdsScript,
    buildHomeTimelineScript,
    buildHomeDomScript,
    filterTweets,
    feedToOperationName,
    feedToCacheKey
};

if (require.main === module) {
    main().catch(error => {
        console.error('未处理的错误:', error);
        process.exit(1);
    });
}
