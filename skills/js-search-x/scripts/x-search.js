#!/usr/bin/env node

/**
 * X.com (Twitter) 搜索脚本
 * 使用 GraphQL API 优先 + 浏览器 DOM 提取兜底的混合方式搜索 X 平台内容
 * 
 * 使用方法:
 *   node scripts/x-search.js "搜索关键词" [options]
 * 
 * 选项:
 *   --max-pages <number>       最多抓取页数（默认1，每页约20条）
 *   --sort <type>              排序方式: top(默认) / latest / media
 *   --pretty                   美化 JSON 输出
 *   --browser-server <url>     JS-Eyes WebSocket 服务器地址（默认 ws://localhost:18080）
 *   --output <file>            指定输出文件路径
 *   --min-likes <number>       过滤最小点赞数（默认0）
 *   --min-retweets <number>    过滤最小转发数（默认0）
 *   --min-replies <number>     过滤最小回复数（默认0）
 *   --lang <code>              搜索语言（如 zh, en）
 *   --from <user>              指定作者（不带@）
 *   --to <user>                发给某用户的推文
 *   --since <date>             起始日期（YYYY-MM-DD）
 *   --until <date>             截止日期（YYYY-MM-DD）
 *   --exclude-replies          排除回复
 *   --exclude-retweets         排除转推
 *   --has-links                仅含链接的推文
 *   --resume <dir>             从中断的搜索目录恢复继续
 * 
 * 文件保存位置:
 *   work_dir/scrape/x_com_search/{keyword}_{timestamp}/data.json
 * 
 * 示例:
 *   node scripts/x-search.js "AI agent"
 *   node scripts/x-search.js "AI agent" --sort latest --max-pages 3
 *   node scripts/x-search.js "AI agent" --min-likes 100 --pretty
 *   node scripts/x-search.js "机器学习" --lang zh --sort latest
 *   node scripts/x-search.js "AI" --from elonmusk --since 2025-01-01
 *   node scripts/x-search.js "AI" --exclude-replies --exclude-retweets --has-links
 *   node scripts/x-search.js --resume work_dir/scrape/x_com_search/AI_2025-01-01T12-00-00
 * 
 * 注意:
 *   - 需要 JS-Eyes Server 运行中，且浏览器已安装 JS-Eyes 扩展并登录 X.com
 *   - X.com 搜索需要登录状态
 */

const { BrowserAutomation } = require('../lib/js-eyes-client');
const path = require('path');
const { searchTweets } = require('../lib/api');
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
    ensureDirectoryExists,
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

/** 硬编码的 fallback queryId（仅在动态发现失败时使用） */
const FALLBACK_QUERY_ID = 'MJnbGMELgGmSiYRHVBRKjg';

/**
 * 是否启用 GraphQL API 搜索。
 * 目前 SearchTimeline GraphQL API 返回 404（可能是 X.com 接口迁移），
 * 暂时停用，直接使用 DOM 提取方式。
 * 设为 true 可恢复 GraphQL 优先策略。
 */
const ENABLE_GRAPHQL_SEARCH = false;

// ============================================================================
// CLI 参数解析
// ============================================================================

function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        keyword: null,
        maxPages: 1,
        sort: 'top',       // top / latest / media
        pretty: false,
        browserServer: null,
        output: null,
        minLikes: 0,
        minRetweets: 0,
        minReplies: 0,
        lang: null,
        from: null,
        to: null,
        since: null,
        until: null,
        excludeReplies: false,
        excludeRetweets: false,
        hasLinks: false,
        resume: null
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg.startsWith('--')) {
            const key = arg.replace('--', '').replace(/-/g, '');
            const nextArg = args[i + 1];

            switch (key) {
                case 'maxpages':
                    options.maxPages = parseInt(nextArg, 10) || 1;
                    i++;
                    break;
                case 'sort':
                    options.sort = nextArg || 'top';
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
                case 'minreplies':
                    options.minReplies = parseInt(nextArg, 10) || 0;
                    i++;
                    break;
                case 'lang':
                    options.lang = nextArg;
                    i++;
                    break;
                case 'from':
                    options.from = nextArg;
                    i++;
                    break;
                case 'to':
                    options.to = nextArg;
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
                case 'excludereplies':
                    options.excludeReplies = true;
                    break;
                case 'excluderetweets':
                    options.excludeRetweets = true;
                    break;
                case 'haslinks':
                    options.hasLinks = true;
                    break;
                case 'resume':
                    options.resume = nextArg;
                    i++;
                    break;
                default:
                    console.warn(`未知选项: ${arg}`);
            }
        } else if (!options.keyword) {
            options.keyword = arg;
        }
    }

    return options;
}

// ============================================================================
// 查询操作符构建
// ============================================================================

/**
 * 将 options 中的高级搜索选项构建为 X 搜索操作符字符串
 * @param {Object} options - 搜索选项
 * @returns {string} 操作符字符串（不含关键词本身）
 */
function buildQueryOperators(options) {
    const operators = [];

    if (options.from) operators.push(`from:${options.from}`);
    if (options.to) operators.push(`to:${options.to}`);
    if (options.since) operators.push(`since:${options.since}`);
    if (options.until) operators.push(`until:${options.until}`);
    if (options.lang) operators.push(`lang:${options.lang}`);
    if (options.minLikes > 0) operators.push(`min_faves:${options.minLikes}`);
    if (options.minRetweets > 0) operators.push(`min_retweets:${options.minRetweets}`);
    if (options.minReplies > 0) operators.push(`min_replies:${options.minReplies}`);
    if (options.excludeReplies) operators.push('-filter:replies');
    if (options.excludeRetweets) operators.push('-filter:retweets');
    if (options.hasLinks) operators.push('filter:links');

    return operators.join(' ');
}

/**
 * 构建完整的查询字符串（关键词 + 操作符）
 * @param {string} keyword - 搜索关键词
 * @param {Object} options - 搜索选项
 * @returns {string} 完整查询字符串
 */
function buildFullQuery(keyword, options) {
    const operators = buildQueryOperators(options);
    return operators ? `${keyword} ${operators}` : keyword;
}

// ============================================================================
// URL 构建
// ============================================================================

/**
 * 构建 X.com 搜索 URL
 * @param {string} keyword - 搜索关键词
 * @param {Object} options - 搜索选项
 * @returns {string} 搜索 URL
 */
function buildSearchUrl(keyword, options) {
    const params = new URLSearchParams();

    const query = buildFullQuery(keyword, options);
    params.set('q', query);
    params.set('src', 'typed_query');
    
    // 排序/筛选类型
    const sortMap = {
        'top': '',           // 默认不设 f 参数 = 热门
        'latest': 'live',
        'media': 'image'
    };
    
    const sortValue = sortMap[options.sort];
    if (sortValue) {
        params.set('f', sortValue);
    }
    
    return `https://x.com/search?${params.toString()}`;
}

/**
 * 将 sort 选项映射为 GraphQL API 的 product 参数
 */
function sortToProduct(sort) {
    const map = {
        'top': 'Top',
        'latest': 'Latest',
        'media': 'Media'
    };
    return map[sort] || 'Top';
}

// ============================================================================
// 浏览器内执行的 DOM 提取脚本（搜索专用，使用 xUtils 中的 buildTweetParserSnippet）
// ============================================================================

/**
 * 生成在浏览器上下文中执行的推文提取脚本
 * 返回一段 JS 代码字符串，执行后返回推文数组
 */
function buildDomExtractionScript() {
    return `
    (() => {
        ${buildTweetParserSnippet()}
        
        const tweets = [];
        const seenIds = new Set();
        const articles = document.querySelectorAll('article[data-testid="tweet"]');
        
        articles.forEach(article => {
            try {
                const tweet = parseTweetArticle(article);
                if (tweet && !seenIds.has(tweet.tweetId)) {
                    seenIds.add(tweet.tweetId);
                    tweets.push(tweet);
                }
            } catch (e) {
                // 跳过解析失败的推文
            }
        });
        
        return tweets;
    })();
    `;
}

// ============================================================================
// 浏览器内执行的 GraphQL 参数发现脚本
// ============================================================================

/**
 * 生成动态发现 GraphQL queryId 和 features 的浏览器端脚本
 * 
 * 发现策略：
 * 1. 从 performance.getEntriesByType('resource') 匹配已有的 SearchTimeline 请求
 * 2. 从匹配到的 URL 中解析 queryId 和 features
 * 3. 如果 performance API 未捕获到，尝试从页面 JS bundle 中搜索 queryId
 * 
 * @returns {string} JS 代码字符串
 */
function buildDiscoverGraphQLParamsScript() {
    return `
    (async () => {
        try {
            const result = { queryId: null, features: null, variables: null };
            
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
            
            // 策略 1: 从 performance API 中匹配 SearchTimeline 请求
            // 取最后一条匹配（最新的请求最可能有当前有效的 queryId）
            try {
                const resources = performance.getEntriesByType('resource');
                for (let i = resources.length - 1; i >= 0; i--) {
                    const r = resources[i];
                    const pathMatch = r.name.match(/graphql\\/([A-Za-z0-9_-]+)\\/SearchTimeline/);
                    if (pathMatch) {
                        result.queryId = pathMatch[1];
                        const parsed = parseGraphQLUrl(r.name);
                        if (parsed.features) result.features = parsed.features;
                        if (parsed.variables) result.variables = parsed.variables;
                        break;
                    }
                }
            } catch (e) {}
            
            // 策略 2: 如果未找到 queryId，尝试从 JS bundle 中搜索
            if (!result.queryId) {
                try {
                    const scripts = document.querySelectorAll('script[src]');
                    const bundleUrls = [];
                    for (const script of scripts) {
                        const src = script.getAttribute('src') || '';
                        if (src.includes('/client-web/') || src.includes('main.')) {
                            bundleUrls.push(src.startsWith('http') ? src : 'https://x.com' + src);
                        }
                    }
                    
                    // 只检查前 5 个 bundle，避免过多请求
                    for (const bundleUrl of bundleUrls.slice(0, 5)) {
                        try {
                            const resp = await fetch(bundleUrl);
                            if (!resp.ok) continue;
                            const text = await resp.text();
                            
                            const match = text.match(/queryId:"([A-Za-z0-9_-]+)",operationName:"SearchTimeline"/);
                            if (match) {
                                result.queryId = match[1];
                                break;
                            }
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
// 浏览器内执行的 GraphQL 搜索脚本
// ============================================================================

/**
 * 生成 GraphQL SearchTimeline API 调用脚本
 * 在浏览器上下文中执行，利用已有的认证会话
 * 
 * @param {string} keyword - 搜索关键词（含高级操作符）
 * @param {string} product - 搜索类型: Top / Latest / Media
 * @param {string} cursor - 分页游标（首页为空）
 * @param {Object} [graphqlParams] - 动态发现的 GraphQL 参数
 * @param {string} [graphqlParams.queryId] - 动态发现的 queryId
 * @param {Object} [graphqlParams.features] - 动态发现的 features
 * @returns {string} JS 代码字符串
 */
function buildGraphQLSearchScript(keyword, product, cursor, graphqlParams = {}) {
    // 转义关键词中的特殊字符，防止注入
    const safeKeyword = keyword.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
    const safeCursor = (cursor || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
    
    // 使用动态发现的参数或 fallback
    const queryIdToUse = graphqlParams.queryId || FALLBACK_QUERY_ID;
    const featuresToUse = graphqlParams.features || DEFAULT_GRAPHQL_FEATURES;
    const featuresLiteral = JSON.stringify(featuresToUse);
    // 使用捕获的 variables 模板，或 null
    const variablesTemplateLiteral = graphqlParams.variables ? JSON.stringify(graphqlParams.variables) : 'null';
    
    // 每次生成唯一 nonce，防止 WebSocket 服务端请求去重
    const nonce = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    
    return `
    (async () => {
        try {
            const _nonce = '${nonce}'; // 唯一标识，防止请求去重
            const ct0 = document.cookie.match(/ct0=([^;]+)/)?.[1];
            if (!ct0) {
                return { success: false, error: '未找到 ct0 cookie，请确保已登录 X.com' };
            }
            
            ${buildGraphQLTweetParserSnippet()}
            
            const queryId = '${queryIdToUse}';
            
            // 优先使用从实际请求捕获的 variables 模板
            const capturedTemplate = ${variablesTemplateLiteral};
            let variables;
            if (capturedTemplate) {
                variables = { ...capturedTemplate };
                // 覆盖关键字段
                variables.rawQuery = '${safeKeyword}';
                variables.product = '${product}';
                delete variables.cursor;
            } else {
                // 回退：尝试从当前页面的 performance API 获取实际 variables
                let liveVariables = null;
                try {
                    const resources = performance.getEntriesByType('resource');
                    for (const r of resources) {
                        if (r.name.includes('/SearchTimeline')) {
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
                    variables.rawQuery = '${safeKeyword}';
                    variables.product = '${product}';
                    delete variables.cursor;
                } else {
                    variables = {
                        rawQuery: '${safeKeyword}',
                        count: 20,
                        querySource: 'typed_query',
                        product: '${product}'
                    };
                }
            }
            
            ${safeCursor ? `variables.cursor = '${safeCursor}';` : ''}
            
            const features = ${featuresLiteral};
            
            const apiUrl = 'https://x.com/i/api/graphql/' + queryId + '/SearchTimeline?' +
                'variables=' + encodeURIComponent(JSON.stringify(variables)) +
                '&features=' + encodeURIComponent(JSON.stringify(features));
            
            // 发送请求
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
                const instructions = data?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions || [];
                
                let allEntries = [];
                for (const instruction of instructions) {
                    if (instruction.type === 'TimelineAddEntries' && instruction.entries) {
                        allEntries = allEntries.concat(instruction.entries);
                    }
                }
                
                const { tweets, nextCursor } = parseTweetEntries(allEntries);
                
                return {
                    success: true,
                    tweets: tweets,
                    nextCursor: nextCursor,
                    queryId: queryId
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

/**
 * 生成一体化首页脚本：等待 + 滚动 + DOM 提取，全部在一次 executeScript 中完成。
 * 
 * 设计原因：BrowserAutomation 的 WebSocket 通道存在已知限制——
 * 每个连接只能成功处理一次 execute_script 调用。
 * 因此需要将所有浏览器端操作合并到单次调用中。
 */
function buildFirstPageScript() {
    return `
    (async () => {
        try {
            const delay = ms => new Promise(r => setTimeout(r, ms));
            
            ${buildTweetParserSnippet()}
            
            // ---- 推文提取函数（从当前 DOM 中提取，跳过已见 ID） ----
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
            
            // ---- Step 1: 等待推文元素出现 ----
            let contentReady = false;
            for (let i = 0; i < 10; i++) {
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
            
            // ---- Step 2: 先提取初始视口中的推文 ----
            extractCurrentTweets();
            
            // ---- Step 3: 滚动并增量提取（X.com 使用虚拟列表，需要边滚边采集） ----
            const maxScrollRounds = 5;
            let noNewCount = 0;
            
            for (let i = 0; i < maxScrollRounds; i++) {
                window.scrollTo(0, document.documentElement.scrollHeight);
                await delay(1500);
                
                const newFound = extractCurrentTweets();
                if (newFound === 0) {
                    noNewCount++;
                    // 连续 2 轮无新增则停止
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

// retryWithBackoff 已移至 xUtils 模块

// 进度管理（saveProgress, loadProgress, appendPartialTweets, loadPartialTweets, cleanupTempFiles）已移至 xUtils 模块

// 文件工具（ensureDirectoryExists, generateTimestamp, saveToFile）已移至 xUtils 模块

// ============================================================================
// 辅助输出函数
// ============================================================================

function printUsage() {
    console.error('错误: 请提供搜索关键词');
    console.log('\n使用方法:');
    console.log('  node scripts/x-search.js "搜索关键词" [options]');
    console.log('\n选项:');
    console.log('  --max-pages <number>       最多抓取页数（默认1，每页约20条）');
    console.log('  --sort <type>              排序: top(默认) / latest / media');
    console.log('  --pretty                   美化 JSON 输出');
    console.log('  --browser-server <url>     浏览器服务器地址');
    console.log('  --output <file>            指定输出文件路径');
    console.log('  --min-likes <number>       过滤最小点赞数（默认0）');
    console.log('  --min-retweets <number>    过滤最小转发数（默认0）');
    console.log('  --min-replies <number>     过滤最小回复数（默认0）');
    console.log('  --lang <code>              搜索语言（如 zh, en）');
    console.log('  --from <user>              指定作者（不带@）');
    console.log('  --to <user>                发给某用户的推文');
    console.log('  --since <date>             起始日期（YYYY-MM-DD）');
    console.log('  --until <date>             截止日期（YYYY-MM-DD）');
    console.log('  --exclude-replies          排除回复');
    console.log('  --exclude-retweets         排除转推');
    console.log('  --has-links                仅含链接的推文');
    console.log('  --resume <dir>             从中断的搜索目录恢复继续');
    console.log('\n示例:');
    console.log('  node scripts/x-search.js "AI agent"');
    console.log('  node scripts/x-search.js "AI agent" --sort latest --max-pages 3');
    console.log('  node scripts/x-search.js "AI agent" --min-likes 100 --pretty');
    console.log('  node scripts/x-search.js "机器学习" --lang zh');
    console.log('  node scripts/x-search.js "AI" --from elonmusk --since 2025-01-01');
    console.log('  node scripts/x-search.js "AI" --exclude-replies --has-links');
    console.log('  node scripts/x-search.js --resume work_dir/scrape/x_com_search/AI_2025-01-01T12-00-00');
}

// printSummary 已移至 xUtils 模块（支持 title 参数）

// ============================================================================
// 主流程（CLI 入口 — 调用 lib/api.js）
// ============================================================================

async function main() {
    const options = parseArgs();

    if (options.resume) {
        return await resumeSearch(options);
    }

    if (!options.keyword) {
        printUsage();
        process.exit(1);
    }

    if (!['top', 'latest', 'media'].includes(options.sort)) {
        console.error(`错误: 无效的排序方式 "${options.sort}"，可选: top / latest / media`);
        process.exit(1);
    }

    const fullQuery = buildFullQuery(options.keyword, options);
    const searchUrl = buildSearchUrl(options.keyword, options);
    const product = sortToProduct(options.sort);

    let outputPath = options.output;
    let outputDir;
    if (!outputPath) {
        const safeKeyword = options.keyword.replace(/[\/\\:*?"<>|]/g, '_').substring(0, 50);
        const timestamp = generateTimestamp();
        const dirName = `${safeKeyword}_${timestamp}`;
        outputDir = path.join(process.cwd(), 'work_dir', 'scrape', 'x_com_search', dirName);
        outputPath = path.join(outputDir, 'data.json');
    } else {
        if (!path.isAbsolute(outputPath)) {
            outputPath = path.join(process.cwd(), 'work_dir', 'scrape', 'x_com_search', outputPath);
        }
        outputDir = path.dirname(outputPath);
    }

    console.log('='.repeat(60));
    console.log('X.com 搜索工具');
    console.log('='.repeat(60));
    console.log(`关键词: ${options.keyword}`);
    console.log(`完整查询: ${fullQuery}`);
    console.log(`搜索 URL: ${searchUrl}`);
    console.log(`排序方式: ${options.sort} (${product})`);
    console.log(`最多页数: ${options.maxPages}`);
    if (options.minLikes > 0) console.log(`最低点赞: ${options.minLikes}`);
    if (options.minRetweets > 0) console.log(`最低转发: ${options.minRetweets}`);
    if (options.minReplies > 0) console.log(`最低回复: ${options.minReplies}`);
    if (options.lang) console.log(`搜索语言: ${options.lang}`);
    if (options.from) console.log(`指定作者: ${options.from}`);
    if (options.to) console.log(`发给用户: ${options.to}`);
    if (options.since) console.log(`起始日期: ${options.since}`);
    if (options.until) console.log(`截止日期: ${options.until}`);
    if (options.excludeReplies) console.log('排除回复: 是');
    if (options.excludeRetweets) console.log('排除转推: 是');
    if (options.hasLinks) console.log('仅含链接: 是');
    console.log(`输出文件: ${outputPath}`);
    console.log('='.repeat(60));

    const browser = new BrowserAutomation(options.browserServer);

    try {
        const result = await searchTweets(browser, options.keyword, {
            ...options,
            logger: console,
            _outputDir: outputDir,
        });

        const output = options.pretty
            ? JSON.stringify(result, null, 2)
            : JSON.stringify(result);
        await saveToFile(outputPath, output);
        await cleanupTempFiles(outputDir);
        printSummary(result.results, '搜索完成');

    } catch (error) {
        console.error('\n✗ 搜索失败:');
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
// 恢复搜索（从中断处继续）
// ============================================================================

async function resumeSearch(options) {
    let resumeDir = options.resume;
    if (!path.isAbsolute(resumeDir)) {
        resumeDir = path.join(process.cwd(), resumeDir);
    }
    
    const state = await loadProgress(resumeDir);
    if (!state) {
        console.error(`错误: 在 ${resumeDir} 中未找到可恢复的搜索进度 (state.json)`);
        process.exit(1);
    }
    
    if (state.type && state.type !== 'x_search') {
        console.error(`错误: state.json 类型不匹配（期望 x_search，实际 ${state.type}）`);
        process.exit(1);
    }
    
    console.log('='.repeat(60));
    console.log('X.com 搜索工具 - 恢复模式');
    console.log('='.repeat(60));
    console.log(`关键词: ${state.keyword}`);
    console.log(`完整查询: ${state.fullQuery}`);
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
        console.log('无更多分页游标，搜索已完成');
    } else if (state.currentPage >= state.options.maxPages) {
        console.log('已达到最大页数限制，搜索已完成');
    } else {
        // 继续抓取
        const mergedOptions = { ...options, ...state.options, keyword: state.keyword };
        const searchUrl = buildSearchUrl(state.keyword, mergedOptions);
        
        const browser = new BrowserAutomation(mergedOptions.browserServer || options.browserServer);
        let tabId = null;
        const safeExecuteScript = createSafeExecuteScript(browser);
        
        let pageDelay = 1500;
        const MIN_PAGE_DELAY = 1500;
        const MAX_PAGE_DELAY = 5000;
        
        try {
            // 打开搜索页以获取 cookie（使用域级别复用）
            console.log('\n打开搜索页面获取认证...');
            const tabResult = await acquireXTab(browser, searchUrl);
            tabId = tabResult.tabId;
            
            if (!tabResult.isReused || tabResult.navigated) {
                try {
                    await waitForPageLoad(browser, tabId, { timeout: 30000 });
                } catch (e) {
                    console.warn('⚠ 等待页面加载超时，继续执行');
                }
            }
            const resumeRenderWait = tabResult.isReused && !tabResult.navigated ? 1000 : 3000;
            await new Promise(resolve => setTimeout(resolve, resumeRenderWait));
            
            let cursor = state.cursor;
            const startPage = state.currentPage + 1;
            let resumeGraphqlParams = state.graphqlParams || {};
            let resumeCacheInvalidated = false;
            
            // 连续 429 计数
            let consecutive429Count = 0;
            const MAX_CONSECUTIVE_429 = 3;
            const LONG_PAUSE_MS = 5 * 60 * 1000; // 5 分钟
            
            for (let page = startPage; page <= state.options.maxPages; page++) {
                console.log(`正在获取第 ${page}/${state.options.maxPages} 页...`);
                
                const startTime = Date.now();
                
                const graphqlResult = await retryWithBackoff(
                    async () => {
                        return await safeExecuteScript(
                            tabId,
                            buildGraphQLSearchScript(state.fullQuery, state.product, cursor, resumeGraphqlParams),
                            { timeout: 30 }
                        );
                    },
                    {
                        maxRetries: 3,
                        baseDelay: 2000,
                        onRetry: (attempt, delay, reason) => {
                            const errMsg = reason?.error || reason?.message || '未知';
                            console.log(`  重试 #${attempt}（等待 ${Math.round(delay / 1000)}s）: ${errMsg}`);
                        }
                    }
                );
                
                const elapsed = Date.now() - startTime;
                
                if (!graphqlResult || !graphqlResult.success) {
                    const statusCode = graphqlResult?.statusCode;
                    
                    // 400/404: 尝试清除缓存重新发现
                    if ((statusCode === 400 || statusCode === 404) && !resumeCacheInvalidated) {
                        resumeCacheInvalidated = true;
                        const failedQueryId = resumeGraphqlParams.queryId;
                        console.warn(`⚠ API 返回 ${statusCode}，尝试重新发现 GraphQL 参数...`);
                        await clearGraphQLCache('SearchTimeline');
                        
                        try {
                            let rediscovery = await safeExecuteScript(
                                tabId,
                                buildDiscoverGraphQLParamsScript(),
                                { timeout: 15 }
                            );
                            
                            // 如果重新发现的 queryId 与失败的相同，强制刷新页面
                            if (rediscovery?.success && rediscovery.queryId === failedQueryId) {
                                console.log('重新发现的 queryId 与失败的相同，强制刷新页面...');
                                try {
                                    await safeExecuteScript(tabId, 'performance.clearResourceTimings(); void 0;', { timeout: 5 });
                                    await browser.openUrl(searchUrl, tabId);
                                    try {
                                        await waitForPageLoad(browser, tabId, { timeout: 30000 });
                                    } catch (e) { /* 超时继续 */ }
                                    await new Promise(resolve => setTimeout(resolve, 4000));
                                    
                                    rediscovery = await safeExecuteScript(
                                        tabId,
                                        buildDiscoverGraphQLParamsScript(),
                                        { timeout: 60 }
                                    );
                                } catch (reloadErr) {
                                    console.warn(`⚠ 页面刷新失败: ${reloadErr.message}`);
                                }
                            }
                            
                            if (rediscovery?.success && rediscovery.queryId && rediscovery.queryId !== failedQueryId) {
                                resumeGraphqlParams.queryId = rediscovery.queryId;
                                resumeGraphqlParams.features = rediscovery.features || resumeGraphqlParams.features;
                                resumeGraphqlParams.variables = rediscovery.variables || resumeGraphqlParams.variables;
                                await saveGraphQLCache('SearchTimeline', resumeGraphqlParams);
                                console.log(`✓ 重新发现 queryId: ${rediscovery.queryId}，重试当前页...`);
                                page--;
                                continue;
                            } else if (rediscovery?.success && rediscovery.queryId) {
                                resumeGraphqlParams.queryId = rediscovery.queryId;
                                resumeGraphqlParams.features = rediscovery.features || resumeGraphqlParams.features;
                                resumeGraphqlParams.variables = rediscovery.variables || resumeGraphqlParams.variables;
                                console.log(`⚠ 刷新后 queryId 仍为 ${rediscovery.queryId}，尝试最后一次重试...`);
                                page--;
                                continue;
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
                            await saveProgress(resumeDir, {
                                ...state,
                                cursor,
                                currentPage: page - 1,
                                totalCollected: allTweets.length,
                                seenIds: [...seenIds],
                                graphqlParams: resumeGraphqlParams,
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
                    let newCount = 0;
                    const newTweets = [];
                    pageTweets.forEach(tweet => {
                        if (!seenIds.has(tweet.tweetId)) {
                            seenIds.add(tweet.tweetId);
                            allTweets.push(tweet);
                            newTweets.push(tweet);
                            newCount++;
                        }
                    });
                    console.log(`✓ 第 ${page} 页获取 ${pageTweets.length} 条推文 (${newCount} 条新增)`);
                    
                    await appendPartialTweets(resumeDir, newTweets);
                    await saveProgress(resumeDir, {
                        ...state,
                        cursor: nextCursor,
                        currentPage: page,
                        totalCollected: allTweets.length,
                        seenIds: [...seenIds],
                        graphqlParams: resumeGraphqlParams,
                        updatedAt: new Date().toISOString()
                    });
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
                    if (elapsed > 5000) {
                        pageDelay = Math.min(pageDelay * 1.5, MAX_PAGE_DELAY);
                    } else {
                        pageDelay = Math.max(pageDelay * 0.9, MIN_PAGE_DELAY);
                    }
                    console.log(`等待 ${(pageDelay / 1000).toFixed(1)} 秒...`);
                    await new Promise(resolve => setTimeout(resolve, pageDelay));
                }
            }
            
            // 释放标签页
            await releaseXTab(browser, tabId);
        } catch (error) {
            console.error('\n✗ 恢复搜索失败:', error.message);
            if (tabId) {
                try { await releaseXTab(browser, tabId); } catch (e) {}
            } else {
                browser.disconnect();
            }
            process.exit(1);
        }
    }
    
    // 应用过滤并保存最终结果
    let filteredTweets = allTweets;
    const opts = state.options;
    if ((opts.minLikes || 0) > 0 || (opts.minRetweets || 0) > 0 || (opts.minReplies || 0) > 0) {
        filteredTweets = allTweets.filter(t => 
            t.stats.likes >= (opts.minLikes || 0) &&
            t.stats.retweets >= (opts.minRetweets || 0) &&
            t.stats.replies >= (opts.minReplies || 0)
        );
        if (filteredTweets.length < allTweets.length) {
            console.log(`\n已过滤不满足互动数条件的推文: ${allTweets.length} → ${filteredTweets.length}`);
        }
    }
    
    const outputPath = state.outputPath || path.join(resumeDir, 'data.json');
    const result = {
        searchKeyword: state.keyword,
        searchUrl: buildSearchUrl(state.keyword, { ...state.options }),
        searchOptions: state.options,
        timestamp: new Date().toISOString(),
        totalResults: filteredTweets.length,
        results: filteredTweets
    };
    
    const output = options.pretty
        ? JSON.stringify(result, null, 2)
        : JSON.stringify(result);
    
    await saveToFile(outputPath, output);
    await cleanupTempFiles(resumeDir);
    printSummary(filteredTweets, '搜索完成');
}

module.exports = {
    main,
    parseArgs,
    buildSearchUrl,
    buildFullQuery,
    buildQueryOperators,
    sortToProduct,
    retryWithBackoff,
    buildDiscoverGraphQLParamsScript,
    buildGraphQLSearchScript,
    buildFirstPageScript,
    buildDomExtractionScript,
    FALLBACK_QUERY_ID,
    ENABLE_GRAPHQL_SEARCH
};

if (require.main === module) {
    main().catch(error => {
        console.error('未处理的错误:', error);
        process.exit(1);
    });
}
