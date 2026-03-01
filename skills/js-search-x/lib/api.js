'use strict';

/**
 * js-search-x 编程 API
 *
 * 提供 4 个纯函数接口，由调用者传入 BrowserAutomation 实例，
 * 返回结构化数据，不做 process.exit、不写文件。
 *
 * 用法:
 *   const { BrowserAutomation } = require('./js-eyes-client');
 *   const { searchTweets, getProfileTweets, getPost, getHomeFeed } = require('./lib/api');
 *   const browser = new BrowserAutomation('ws://localhost:18080');
 *   const result = await searchTweets(browser, 'AI agent', { maxPages: 3 });
 */

const {
    retryWithBackoff,
    createSafeExecuteScript,
    waitForPageLoad,
    acquireXTab,
    releaseXTab,
    loadGraphQLCache,
    saveGraphQLCache,
    clearGraphQLCache,
    saveProgress,
    appendPartialTweets,
} = require('./xUtils');

// Lazy-load script modules to avoid circular dependency
// (scripts import api.js, api.js imports scripts)
let _search, _profile, _post, _home;
function getSearch()  { return _search  || (_search  = require('../scripts/x-search')); }
function getProfile() { return _profile || (_profile = require('../scripts/x-profile')); }
function getPost_()   { return _post    || (_post    = require('../scripts/x-post')); }
function getHome()    { return _home    || (_home    = require('../scripts/x-home')); }

// ============================================================================
// 通用内部辅助
// ============================================================================

function noop() {}
function makeLog(logger) {
    if (!logger) return { log: noop, warn: noop, error: noop };
    return {
        log:   logger.log   || logger.info || noop,
        warn:  logger.warn  || noop,
        error: logger.error || noop,
    };
}

async function openAndWait(browser, tabId, url, safeExec, log) {
    try {
        await safeExec(tabId, 'performance.clearResourceTimings(); void 0;', { timeout: 5 });
        await browser.openUrl(url, tabId);
        try { await waitForPageLoad(browser, tabId, { timeout: 30000 }); } catch (_) {}
        await new Promise(r => setTimeout(r, 4000));
    } catch (e) {
        log.warn(`⚠ 页面刷新失败: ${e.message}`);
    }
}

// ============================================================================
// searchTweets
// ============================================================================

/**
 * 搜索 X.com 推文
 *
 * @param {import('./js-eyes-client').BrowserAutomation} browser
 * @param {string} keyword 搜索关键词
 * @param {object} [options]
 * @param {number}  [options.maxPages=1]
 * @param {string}  [options.sort='top']       top | latest | media
 * @param {number}  [options.minLikes=0]
 * @param {number}  [options.minRetweets=0]
 * @param {number}  [options.minReplies=0]
 * @param {string}  [options.lang]
 * @param {string}  [options.from]
 * @param {string}  [options.to]
 * @param {string}  [options.since]            YYYY-MM-DD
 * @param {string}  [options.until]            YYYY-MM-DD
 * @param {boolean} [options.excludeReplies]
 * @param {boolean} [options.excludeRetweets]
 * @param {boolean} [options.hasLinks]
 * @param {boolean} [options.closeTab=false]
 * @param {object}  [options.logger]           可选 logger ({ log, warn, error })
 * @param {string}  [options._outputDir]       可选，传入后启用增量保存
 * @returns {Promise<{searchKeyword,searchUrl,searchOptions,timestamp,totalResults,results}>}
 */
async function searchTweets(browser, keyword, options = {}) {
    const opts = {
        maxPages: 1, sort: 'top',
        minLikes: 0, minRetweets: 0, minReplies: 0,
        lang: null, from: null, to: null, since: null, until: null,
        excludeReplies: false, excludeRetweets: false, hasLinks: false,
        closeTab: false,
        ...options,
    };
    const log = makeLog(opts.logger);

    const S = getSearch();
    const fullQuery  = S.buildFullQuery(keyword, opts);
    const searchUrl  = S.buildSearchUrl(keyword, opts);
    const product    = S.sortToProduct(opts.sort);

    const safeExecuteScript = createSafeExecuteScript(browser);
    let tabId = null;
    const allTweets = [];
    const seenIds   = new Set();

    let pageDelay = 1500;
    const MIN_PAGE_DELAY = 1500;
    const MAX_PAGE_DELAY = 5000;

    try {
        // Phase 1: 打开搜索页
        log.log('[Phase 1] 打开搜索页面...');
        const tabResult = await acquireXTab(browser, searchUrl);
        tabId = tabResult.tabId;

        if (!tabResult.isReused || tabResult.navigated) {
            try { await waitForPageLoad(browser, tabId, { timeout: 30000 }); } catch (_) {}
        }
        const renderWait = tabResult.isReused && !tabResult.navigated ? 1000 : 3000;
        await new Promise(r => setTimeout(r, renderWait));

        // Phase 2: GraphQL 参数发现
        let graphqlFailed = !S.ENABLE_GRAPHQL_SEARCH;

        if (S.ENABLE_GRAPHQL_SEARCH) {
            log.log('[Phase 2] 获取 GraphQL 参数...');
            let graphqlParams = {};

            const cached = await loadGraphQLCache('SearchTimeline');
            if (cached && cached.queryId) {
                graphqlParams = cached;
                log.log(`✓ 使用缓存的 queryId: ${cached.queryId}`);
            } else {
                try {
                    const disc = await safeExecuteScript(tabId, S.buildDiscoverGraphQLParamsScript(), { timeout: 15 });
                    if (disc?.success) {
                        if (disc.queryId)   graphqlParams.queryId   = disc.queryId;
                        if (disc.features)  graphqlParams.features  = disc.features;
                        if (disc.variables) graphqlParams.variables = disc.variables;
                        if (graphqlParams.queryId) await saveGraphQLCache('SearchTimeline', graphqlParams);
                    }
                } catch (e) {
                    log.warn(`⚠ 动态发现失败: ${e.message}`);
                }
            }
            if (!graphqlParams.queryId) {
                log.log(`使用 fallback queryId: ${S.FALLBACK_QUERY_ID}`);
            }

            // Phase 3: GraphQL 搜索
            log.log('[Phase 3] 使用 GraphQL API 搜索...');
            graphqlFailed = false;
            let cursor = null;
            let cacheInvalidated = false;
            let consecutive429Count = 0;

            for (let page = 1; page <= opts.maxPages; page++) {
                log.log(`正在获取第 ${page}/${opts.maxPages} 页...`);
                const startTime = Date.now();

                const graphqlResult = await retryWithBackoff(
                    async () => safeExecuteScript(tabId, S.buildGraphQLSearchScript(fullQuery, product, cursor, graphqlParams), { timeout: 30 }),
                    { maxRetries: 3, baseDelay: 2000, onRetry: (a, d, r) => log.log(`  重试 #${a}（等待 ${Math.round(d / 1000)}s）: ${r?.error || r?.message || '未知'}`) }
                );
                const elapsed = Date.now() - startTime;

                if (!graphqlResult || !graphqlResult.success) {
                    const statusCode = graphqlResult?.statusCode;

                    if ((statusCode === 400 || statusCode === 404) && !cacheInvalidated) {
                        cacheInvalidated = true;
                        const failedQid = graphqlParams.queryId;
                        log.warn(`⚠ API 返回 ${statusCode}，清除缓存并重新发现...`);
                        await clearGraphQLCache('SearchTimeline');
                        try {
                            let re = await safeExecuteScript(tabId, S.buildDiscoverGraphQLParamsScript(), { timeout: 15 });
                            if (re?.success && re.queryId === failedQid) {
                                await openAndWait(browser, tabId, searchUrl, safeExecuteScript, log);
                                re = await safeExecuteScript(tabId, S.buildDiscoverGraphQLParamsScript(), { timeout: 60 });
                            }
                            if (re?.success && re.queryId) {
                                graphqlParams.queryId   = re.queryId;
                                graphqlParams.features  = re.features  || graphqlParams.features;
                                graphqlParams.variables = re.variables || graphqlParams.variables;
                                await saveGraphQLCache('SearchTimeline', graphqlParams);
                                page--;
                                continue;
                            }
                        } catch (e) { log.warn(`⚠ 重新发现失败: ${e.message}`); }
                    }

                    if (statusCode === 429) {
                        consecutive429Count++;
                        if (consecutive429Count >= 3) {
                            log.log('连续 3 次 429，暂停 5 分钟...');
                            await new Promise(r => setTimeout(r, 5 * 60 * 1000));
                            consecutive429Count = 0;
                            page--;
                            continue;
                        }
                    } else {
                        log.warn(`⚠ GraphQL API 调用失败 (第 ${page} 页): ${graphqlResult?.error || '未知'}`);
                        if (page === 1) graphqlFailed = true;
                        break;
                    }
                }

                if (!graphqlResult || !graphqlResult.success) {
                    if (page === 1) graphqlFailed = true;
                    break;
                } else {
                    consecutive429Count = 0;
                }

                const { tweets: pageTweets, nextCursor } = graphqlResult;
                if (Array.isArray(pageTweets) && pageTweets.length > 0) {
                    let newCount = 0;
                    const newTweets = [];
                    pageTweets.forEach(t => {
                        if (!seenIds.has(t.tweetId)) {
                            seenIds.add(t.tweetId);
                            allTweets.push(t);
                            newTweets.push(t);
                            newCount++;
                        }
                    });
                    log.log(`✓ 第 ${page} 页获取 ${pageTweets.length} 条推文 (${newCount} 条新增)`);
                    if (opts._outputDir) {
                        await appendPartialTweets(opts._outputDir, newTweets);
                    }
                } else {
                    log.log(`第 ${page} 页无更多结果，停止翻页`);
                    break;
                }

                if (nextCursor) { cursor = nextCursor; } else { break; }

                if (page < opts.maxPages) {
                    if (elapsed > 5000)       pageDelay = Math.min(pageDelay * 1.5, MAX_PAGE_DELAY);
                    else                      pageDelay = Math.max(pageDelay * 0.9, MIN_PAGE_DELAY);
                    await new Promise(r => setTimeout(r, pageDelay));
                }
            }
        }

        // Phase 4: DOM 回退
        if (graphqlFailed && allTweets.length === 0) {
            log.log('使用 DOM 提取推文...');
            const domResult = await safeExecuteScript(tabId, S.buildFirstPageScript(), { timeout: 60 });
            if (domResult?.success && domResult.tweets?.length > 0) {
                domResult.tweets.forEach(t => {
                    if (!seenIds.has(t.tweetId)) { seenIds.add(t.tweetId); allTweets.push(t); }
                });
                log.log(`✓ DOM 获取到 ${domResult.tweetCount} 条推文`);
            } else {
                log.warn(`⚠ DOM 也失败: ${domResult?.error || '无推文'}`);
            }
        }

        await releaseXTab(browser, tabId, !opts.closeTab);
        tabId = null;

        // 过滤
        let filteredTweets = allTweets;
        if (opts.minLikes > 0 || opts.minRetweets > 0 || opts.minReplies > 0) {
            filteredTweets = allTweets.filter(t =>
                t.stats.likes    >= opts.minLikes &&
                t.stats.retweets >= opts.minRetweets &&
                t.stats.replies  >= opts.minReplies
            );
        }

        return {
            searchKeyword: keyword,
            searchUrl,
            searchOptions: {
                sort: opts.sort, maxPages: opts.maxPages,
                minLikes: opts.minLikes, minRetweets: opts.minRetweets, minReplies: opts.minReplies,
                lang: opts.lang, from: opts.from, to: opts.to,
                since: opts.since, until: opts.until,
                excludeReplies: opts.excludeReplies, excludeRetweets: opts.excludeRetweets,
                hasLinks: opts.hasLinks,
            },
            timestamp: new Date().toISOString(),
            totalResults: filteredTweets.length,
            results: filteredTweets,
        };
    } catch (err) {
        if (tabId) { try { await releaseXTab(browser, tabId); } catch (_) {} }
        throw err;
    }
}

// ============================================================================
// getProfileTweets
// ============================================================================

/**
 * 获取用户时间线推文
 *
 * @param {import('./js-eyes-client').BrowserAutomation} browser
 * @param {string} username X.com 用户名（不带 @）
 * @param {object} [options]
 * @param {number}  [options.maxPages=50]
 * @param {number}  [options.maxTweets=0]      0 = 不限
 * @param {string}  [options.since]
 * @param {string}  [options.until]
 * @param {boolean} [options.includeReplies=false]
 * @param {boolean} [options.includeRetweets=false]
 * @param {number}  [options.minLikes=0]
 * @param {number}  [options.minRetweets=0]
 * @param {boolean} [options.closeTab=false]
 * @param {object}  [options.logger]
 * @param {string}  [options._outputDir]
 * @returns {Promise<{username,profile,scrapeOptions,timestamp,totalResults,results}>}
 */
async function getProfileTweets(browser, username, options = {}) {
    const opts = {
        maxPages: 50, maxTweets: 0,
        since: null, until: null,
        includeReplies: false, includeRetweets: false,
        minLikes: 0, minRetweets: 0,
        closeTab: false,
        ...options,
    };
    const log = makeLog(opts.logger);
    const P = getProfile();
    const profileUrl = `https://x.com/${username}`;
    const safeExecuteScript = createSafeExecuteScript(browser);
    let tabId = null;
    const allTweets = [];
    const seenIds = new Set();
    let userProfile = null;

    let pageDelay = 3000;
    const MIN_PAGE_DELAY = 3000;
    const MAX_PAGE_DELAY = 8000;
    let consecutive429Count = 0;

    try {
        // Phase 1
        log.log('[Phase 1] 获取浏览器标签页...');
        const tabResult = await acquireXTab(browser, profileUrl);
        tabId = tabResult.tabId;
        if (!tabResult.isReused || tabResult.navigated) {
            try { await waitForPageLoad(browser, tabId, { timeout: 30000 }); } catch (_) {}
        }
        const renderWait = tabResult.isReused && !tabResult.navigated ? 1000 : 4000;
        await new Promise(r => setTimeout(r, renderWait));

        // Phase 2: GraphQL 参数发现
        log.log('[Phase 2] 获取 GraphQL 参数...');
        let graphqlParams = {};
        const cacheKey = 'UserProfile';
        const cached = await loadGraphQLCache(cacheKey);
        if (cached && cached.userByScreenNameQueryId && cached.userTweetsQueryId) {
            graphqlParams = cached;
        } else {
            try {
                const disc = await safeExecuteScript(tabId, P.buildDiscoverUserQueryIdsScript(), { timeout: 60 });
                if (disc?.success) {
                    if (disc.userByScreenNameQueryId)      graphqlParams.userByScreenNameQueryId      = disc.userByScreenNameQueryId;
                    if (disc.userTweetsQueryId)             graphqlParams.userTweetsQueryId             = disc.userTweetsQueryId;
                    if (disc.userTweetsAndRepliesQueryId)   graphqlParams.userTweetsAndRepliesQueryId   = disc.userTweetsAndRepliesQueryId;
                    if (disc.features)                      graphqlParams.features                      = disc.features;
                    if (graphqlParams.userByScreenNameQueryId && graphqlParams.userTweetsQueryId) {
                        await saveGraphQLCache(cacheKey, graphqlParams);
                    }
                }
            } catch (e) {
                log.warn(`⚠ 动态发现失败: ${e.message}`);
            }
        }

        if (!graphqlParams.userByScreenNameQueryId) {
            throw new Error('无法发现 UserByScreenName queryId，请确保已登录 X.com');
        }

        // Phase 3: 获取用户信息
        log.log('[Phase 3] 获取用户信息...');
        const userInfoResult = await retryWithBackoff(
            async () => safeExecuteScript(tabId, P.buildUserByScreenNameScript(username, graphqlParams.userByScreenNameQueryId, graphqlParams.features), { timeout: 60 }),
            { maxRetries: 3, baseDelay: 2000 }
        );
        if (!userInfoResult || !userInfoResult.success) {
            throw new Error(`获取用户信息失败: ${userInfoResult?.error || '未知错误'}`);
        }
        const userId = userInfoResult.userId;
        userProfile = userInfoResult.profile;
        log.log(`✓ 用户: ${userProfile.name} (@${userProfile.screenName}) | 推文: ${userProfile.tweetCount}`);

        // Phase 4: UserTweets 翻页
        let tweetsQueryId = opts.includeReplies
            ? (graphqlParams.userTweetsAndRepliesQueryId || graphqlParams.userTweetsQueryId)
            : graphqlParams.userTweetsQueryId;
        if (!tweetsQueryId) throw new Error('无法发现 UserTweets queryId');

        log.log('[Phase 4] 获取推文...');
        let graphqlFailed = false;
        let cursor = null;
        let hitSinceLimit = false;
        let cacheInvalidated = false;

        for (let page = 1; page <= opts.maxPages; page++) {
            log.log(`正在获取第 ${page}/${opts.maxPages} 页...`);
            const startTime = Date.now();

            const graphqlResult = await retryWithBackoff(
                async () => safeExecuteScript(tabId, P.buildUserTweetsScript(userId, cursor, tweetsQueryId, graphqlParams.features, opts.includeReplies), { timeout: 30 }),
                { maxRetries: 3, baseDelay: 3000, maxDelay: 30000 }
            );
            const elapsed = Date.now() - startTime;

            if (!graphqlResult || !graphqlResult.success) {
                const statusCode = graphqlResult?.statusCode;
                if (statusCode === 400 && !cacheInvalidated) {
                    cacheInvalidated = true;
                    await clearGraphQLCache(cacheKey);
                    try {
                        const re = await safeExecuteScript(tabId, P.buildDiscoverUserQueryIdsScript(), { timeout: 60 });
                        if (re?.success) {
                            const newQid = opts.includeReplies
                                ? (re.userTweetsAndRepliesQueryId || re.userTweetsQueryId)
                                : re.userTweetsQueryId;
                            if (newQid) {
                                graphqlParams.userTweetsQueryId = re.userTweetsQueryId || graphqlParams.userTweetsQueryId;
                                graphqlParams.userTweetsAndRepliesQueryId = re.userTweetsAndRepliesQueryId || graphqlParams.userTweetsAndRepliesQueryId;
                                graphqlParams.features = re.features || graphqlParams.features;
                                tweetsQueryId = newQid;
                                await saveGraphQLCache(cacheKey, graphqlParams);
                                page--; continue;
                            }
                        }
                    } catch (e) { log.warn(`⚠ 重新发现失败: ${e.message}`); }
                }
                if (statusCode === 429) {
                    consecutive429Count++;
                    if (consecutive429Count >= 3) {
                        await new Promise(r => setTimeout(r, 5 * 60 * 1000));
                        consecutive429Count = 0;
                        page--; continue;
                    }
                } else {
                    if (page === 1) graphqlFailed = true;
                    break;
                }
            }
            if (!graphqlResult || !graphqlResult.success) { if (page === 1) graphqlFailed = true; break; }
            consecutive429Count = 0;

            const { tweets: pageTweets, nextCursor } = graphqlResult;
            if (Array.isArray(pageTweets) && pageTweets.length > 0) {
                const { filtered, hitSinceLimit: hit } = P.filterTweets(pageTweets, opts);
                hitSinceLimit = hit;
                let newCount = 0;
                const newTweets = [];
                filtered.forEach(t => {
                    if (!seenIds.has(t.tweetId)) { seenIds.add(t.tweetId); allTweets.push(t); newTweets.push(t); newCount++; }
                });
                log.log(`✓ 第 ${page} 页: ${pageTweets.length} 条, ${newCount} 条新增, 累计 ${allTweets.length}`);
                if (opts._outputDir) await appendPartialTweets(opts._outputDir, newTweets);
                if (hitSinceLimit) break;
                if (opts.maxTweets > 0 && allTweets.length >= opts.maxTweets) break;
            } else { break; }

            if (nextCursor) { cursor = nextCursor; } else { break; }
            if (page < opts.maxPages) {
                if (elapsed > 8000) pageDelay = Math.min(pageDelay * 1.5, MAX_PAGE_DELAY);
                else if (elapsed < 3000) pageDelay = Math.max(pageDelay * 0.9, MIN_PAGE_DELAY);
                await new Promise(r => setTimeout(r, pageDelay));
            }
        }

        // Phase 5: DOM 回退
        if (graphqlFailed && allTweets.length === 0) {
            log.log('回退到 DOM 提取...');
            const dom = await safeExecuteScript(tabId, P.buildProfileDomScript(), { timeout: 60 });
            if (dom?.success && dom.tweets?.length > 0) {
                const { filtered } = P.filterTweets(dom.tweets, opts);
                filtered.forEach(t => { if (!seenIds.has(t.tweetId)) { seenIds.add(t.tweetId); allTweets.push(t); } });
            }
        }

        await releaseXTab(browser, tabId, !opts.closeTab);
        tabId = null;

        let filteredTweets = allTweets;
        if (opts.minLikes > 0 || opts.minRetweets > 0) {
            filteredTweets = allTweets.filter(t => t.stats.likes >= opts.minLikes && t.stats.retweets >= opts.minRetweets);
        }
        if (opts.maxTweets > 0 && filteredTweets.length > opts.maxTweets) {
            filteredTweets = filteredTweets.slice(0, opts.maxTweets);
        }

        return {
            username,
            profile: userProfile,
            scrapeOptions: {
                maxPages: opts.maxPages, maxTweets: opts.maxTweets,
                since: opts.since, until: opts.until,
                includeReplies: opts.includeReplies, includeRetweets: opts.includeRetweets,
                minLikes: opts.minLikes, minRetweets: opts.minRetweets,
            },
            timestamp: new Date().toISOString(),
            totalResults: filteredTweets.length,
            results: filteredTweets,
        };
    } catch (err) {
        if (tabId) { try { await releaseXTab(browser, tabId); } catch (_) {} }
        throw err;
    }
}

// ============================================================================
// getPost
// ============================================================================

/**
 * 获取推文详情
 *
 * @param {import('./js-eyes-client').BrowserAutomation} browser
 * @param {string|string[]} tweetInputs 推文 URL 或 ID（单个或数组）
 * @param {object} [options]
 * @param {boolean} [options.withThread=false]
 * @param {number}  [options.withReplies=0]
 * @param {boolean} [options.closeTab=false]
 * @param {object}  [options.logger]
 * @returns {Promise<{scrapeType,scrapeOptions,timestamp,totalRequested,totalSuccess,totalFailed,results}>}
 */
async function getPost(browser, tweetInputs, options = {}) {
    const opts = { withThread: false, withReplies: 0, closeTab: false, ...options };
    const log = makeLog(opts.logger);
    const T = getPost_();

    const inputs = Array.isArray(tweetInputs) ? tweetInputs : [tweetInputs];
    const tweetIds = inputs.map(inp => {
        const id = T.extractTweetId(inp);
        if (!id) throw new Error(`无法解析推文 ID: "${inp}"`);
        return id;
    });

    const safeExecuteScript = createSafeExecuteScript(browser);
    let tabId = null;
    const allResults = [];

    try {
        // Phase 1
        log.log('[Phase 1] 获取浏览器标签页...');
        const firstUrl = `https://x.com/i/status/${tweetIds[0]}`;
        const tabResult = await acquireXTab(browser, firstUrl);
        tabId = tabResult.tabId;
        if (!tabResult.isReused || tabResult.navigated) {
            try { await waitForPageLoad(browser, tabId, { timeout: 30000 }); } catch (_) {}
        }
        const renderWait = tabResult.isReused && !tabResult.navigated ? 1000 : 4000;
        await new Promise(r => setTimeout(r, renderWait));

        // Phase 2: GraphQL 参数
        log.log('[Phase 2] 获取 GraphQL 参数...');
        let graphqlParams = {};
        const cacheKey = 'TweetDetail';
        const cached = await loadGraphQLCache(cacheKey);
        if (cached && (cached.tweetDetailQueryId || cached.tweetResultByRestIdQueryId)) {
            graphqlParams = cached;
        } else {
            try {
                const disc = await safeExecuteScript(tabId, T.buildDiscoverTweetQueryIdsScript(), { timeout: 60 });
                if (disc?.success) {
                    if (disc.tweetDetailQueryId)          graphqlParams.tweetDetailQueryId          = disc.tweetDetailQueryId;
                    if (disc.tweetResultByRestIdQueryId)   graphqlParams.tweetResultByRestIdQueryId   = disc.tweetResultByRestIdQueryId;
                    if (disc.features)                     graphqlParams.features                     = disc.features;
                    if (graphqlParams.tweetDetailQueryId || graphqlParams.tweetResultByRestIdQueryId) {
                        await saveGraphQLCache(cacheKey, graphqlParams);
                    }
                }
            } catch (e) { log.warn(`⚠ 动态发现失败: ${e.message}`); }
        }

        const detailQid = graphqlParams.tweetDetailQueryId;
        const restIdQid = graphqlParams.tweetResultByRestIdQueryId;
        if (!detailQid && !restIdQid) {
            throw new Error('无法获取 TweetDetail 或 TweetResultByRestId queryId');
        }

        // Phase 3: 逐条抓取
        log.log(`[Phase 3] 抓取推文 (共 ${tweetIds.length} 条)...`);
        let cacheInvalidated = false;

        for (let i = 0; i < tweetIds.length; i++) {
            const tweetId = tweetIds[i];
            log.log(`抓取第 ${i + 1}/${tweetIds.length} 条: ${tweetId}`);

            let tweetResult = null;
            let graphqlFailed = false;
            const collectReplies = opts.withReplies > 0;

            // 策略 1: TweetDetail
            if (detailQid) {
                tweetResult = await retryWithBackoff(
                    async () => safeExecuteScript(tabId, T.buildTweetDetailScript(tweetId, detailQid, graphqlParams.features, opts.withThread, collectReplies), { timeout: 30 }),
                    { maxRetries: 3, baseDelay: 3000, maxDelay: 30000 }
                );
                if (tweetResult && !tweetResult.success && tweetResult.statusCode === 400 && !cacheInvalidated) {
                    cacheInvalidated = true;
                    await clearGraphQLCache(cacheKey);
                    try {
                        const re = await safeExecuteScript(tabId, T.buildDiscoverTweetQueryIdsScript(), { timeout: 60 });
                        if (re?.success) {
                            if (re.tweetDetailQueryId)        graphqlParams.tweetDetailQueryId        = re.tweetDetailQueryId;
                            if (re.tweetResultByRestIdQueryId) graphqlParams.tweetResultByRestIdQueryId = re.tweetResultByRestIdQueryId;
                            graphqlParams.features = re.features || graphqlParams.features;
                            await saveGraphQLCache(cacheKey, graphqlParams);
                            tweetResult = await safeExecuteScript(tabId, T.buildTweetDetailScript(tweetId, graphqlParams.tweetDetailQueryId || detailQid, graphqlParams.features, opts.withThread, collectReplies), { timeout: 30 });
                        }
                    } catch (_) {}
                }
                if (!tweetResult || !tweetResult.success) graphqlFailed = true;

                // 回复翻页
                if (!graphqlFailed && collectReplies && tweetResult?.replyCursor) {
                    const allReplies = [...(tweetResult.replies || [])];
                    const seenReplyIds = new Set(allReplies.map(r => r.tweetId));
                    let replyCursor = tweetResult.replyCursor;
                    const maxReplyPages = Math.ceil(opts.withReplies / 20) + 1;

                    for (let rp = 1; rp <= maxReplyPages; rp++) {
                        if (allReplies.length >= opts.withReplies || !replyCursor) break;
                        const cur = await retryWithBackoff(
                            async () => safeExecuteScript(tabId, T.buildTweetDetailCursorScript(tweetId, replyCursor, graphqlParams.tweetDetailQueryId || detailQid, graphqlParams.features), { timeout: 30 }),
                            { maxRetries: 2, baseDelay: 3000, maxDelay: 15000 }
                        );
                        if (!cur || !cur.success) break;
                        let newCount = 0;
                        for (const reply of (cur.replies || [])) {
                            if (!seenReplyIds.has(reply.tweetId)) { seenReplyIds.add(reply.tweetId); allReplies.push(reply); newCount++; }
                        }
                        if (newCount === 0) break;
                        replyCursor = cur.nextCursor;
                        await new Promise(r => setTimeout(r, 2000));
                    }
                    tweetResult.replies = allReplies.slice(0, opts.withReplies);
                }
            } else {
                graphqlFailed = true;
            }

            // 策略 2: TweetResultByRestId
            if (graphqlFailed && restIdQid) {
                tweetResult = await retryWithBackoff(
                    async () => safeExecuteScript(tabId, T.buildTweetByRestIdScript(tweetId, restIdQid, graphqlParams.features), { timeout: 30 }),
                    { maxRetries: 3, baseDelay: 3000, maxDelay: 30000 }
                );
                if (!tweetResult || !tweetResult.success) graphqlFailed = true;
                else graphqlFailed = false;
            }

            // 策略 3: DOM 回退
            if (graphqlFailed) {
                const tweetUrl = `https://x.com/i/status/${tweetId}`;
                try { await browser.openUrl(tweetUrl, tabId); await new Promise(r => setTimeout(r, 4000)); } catch (_) {}
                const dom = await safeExecuteScript(tabId, T.buildPostDomScript(tweetId), { timeout: 60 });
                if (dom?.success && dom.focalTweet) { tweetResult = dom; }
                else {
                    allResults.push({ tweetId, error: tweetResult?.error || dom?.error || '抓取失败', success: false });
                    continue;
                }
            }

            if (tweetResult?.success && tweetResult.focalTweet) {
                const postData = { tweetId, success: true, ...tweetResult.focalTweet };
                if (tweetResult.threadTweets?.length > 0) postData.threadTweets = tweetResult.threadTweets;
                if (tweetResult.replies?.length > 0)      postData.replies      = tweetResult.replies;
                allResults.push(postData);
            }

            if (i < tweetIds.length - 1) await new Promise(r => setTimeout(r, 2000));
        }

        await releaseXTab(browser, tabId, !opts.closeTab);
        tabId = null;

        return {
            scrapeType: 'x_post',
            scrapeOptions: { withThread: opts.withThread, withReplies: opts.withReplies },
            timestamp: new Date().toISOString(),
            totalRequested: tweetIds.length,
            totalSuccess: allResults.filter(r => r.success).length,
            totalFailed:  allResults.filter(r => !r.success).length,
            results: allResults,
        };
    } catch (err) {
        if (tabId) { try { await releaseXTab(browser, tabId); } catch (_) {} }
        throw err;
    }
}

// ============================================================================
// getHomeFeed
// ============================================================================

/**
 * 获取首页推荐
 *
 * @param {import('./js-eyes-client').BrowserAutomation} browser
 * @param {object} [options]
 * @param {string}  [options.feed='foryou']    foryou | following
 * @param {number}  [options.maxPages=5]
 * @param {number}  [options.maxTweets=0]
 * @param {number}  [options.minLikes=0]
 * @param {number}  [options.minRetweets=0]
 * @param {boolean} [options.excludeReplies=false]
 * @param {boolean} [options.excludeRetweets=false]
 * @param {boolean} [options.closeTab=false]
 * @param {object}  [options.logger]
 * @param {string}  [options._outputDir]
 * @returns {Promise<{feed,scrapeOptions,timestamp,totalResults,results}>}
 */
async function getHomeFeed(browser, options = {}) {
    const opts = {
        feed: 'foryou', maxPages: 5, maxTweets: 0,
        minLikes: 0, minRetweets: 0,
        excludeReplies: false, excludeRetweets: false,
        closeTab: false,
        ...options,
    };
    const log = makeLog(opts.logger);

    const H = getHome();
    const operationName = H.feedToOperationName(opts.feed);
    const cacheKey = H.feedToCacheKey(opts.feed);
    const homeUrl = 'https://x.com/home';

    const safeExecuteScript = createSafeExecuteScript(browser);
    let tabId = null;
    const allTweets = [];
    const seenIds = new Set();

    let pageDelay = 3000;
    const MIN_PAGE_DELAY = 3000;
    const MAX_PAGE_DELAY = 8000;
    let consecutive429Count = 0;

    try {
        // Phase 1
        log.log('[Phase 1] 获取浏览器标签页...');
        const tabResult = await acquireXTab(browser, homeUrl);
        tabId = tabResult.tabId;
        if (!tabResult.isReused || tabResult.navigated) {
            try { await waitForPageLoad(browser, tabId, { timeout: 30000 }); } catch (_) {}
        }
        const renderWait = tabResult.isReused && !tabResult.navigated ? 1000 : 4000;
        await new Promise(r => setTimeout(r, renderWait));

        // Phase 2: GraphQL 参数
        log.log('[Phase 2] 获取 GraphQL 参数...');
        let graphqlParams = {};
        const cached = await loadGraphQLCache(cacheKey);
        if (cached && cached.queryId) {
            graphqlParams = cached;
        } else {
            try {
                const disc = await safeExecuteScript(tabId, H.buildDiscoverHomeQueryIdsScript(), { timeout: 60 });
                if (disc?.success) {
                    if (disc.homeTimelineQueryId)       graphqlParams.homeTimelineQueryId       = disc.homeTimelineQueryId;
                    if (disc.homeLatestTimelineQueryId)  graphqlParams.homeLatestTimelineQueryId  = disc.homeLatestTimelineQueryId;
                    if (disc.features)                   graphqlParams.features                   = disc.features;
                    if (disc.variables)                  graphqlParams.variables                  = disc.variables;
                    graphqlParams.queryId = opts.feed === 'following'
                        ? (graphqlParams.homeLatestTimelineQueryId || graphqlParams.homeTimelineQueryId)
                        : (graphqlParams.homeTimelineQueryId || graphqlParams.homeLatestTimelineQueryId);
                    if (graphqlParams.queryId) await saveGraphQLCache(cacheKey, graphqlParams);
                }
            } catch (e) { log.warn(`⚠ 动态发现失败: ${e.message}`); }
        }

        const queryId = graphqlParams.queryId
            || (opts.feed === 'following' ? graphqlParams.homeLatestTimelineQueryId : graphqlParams.homeTimelineQueryId)
            || graphqlParams.homeTimelineQueryId;
        if (!queryId) throw new Error('无法获取 HomeTimeline queryId');

        // Phase 3: 翻页
        log.log(`[Phase 3] 使用 ${operationName} API 翻页...`);
        let graphqlFailed = false;
        let cursor = null;
        let cacheInvalidated = false;

        for (let page = 1; page <= opts.maxPages; page++) {
            log.log(`正在获取第 ${page}/${opts.maxPages} 页...`);
            const startTime = Date.now();

            const graphqlResult = await retryWithBackoff(
                async () => safeExecuteScript(tabId, H.buildHomeTimelineScript(cursor, queryId, graphqlParams.features, operationName, graphqlParams.variables), { timeout: 30 }),
                { maxRetries: 3, baseDelay: 3000, maxDelay: 30000 }
            );
            const elapsed = Date.now() - startTime;

            if (!graphqlResult || !graphqlResult.success) {
                const statusCode = graphqlResult?.statusCode;
                if (statusCode === 400 && !cacheInvalidated) {
                    cacheInvalidated = true;
                    await clearGraphQLCache(cacheKey);
                    try {
                        const re = await safeExecuteScript(tabId, H.buildDiscoverHomeQueryIdsScript(), { timeout: 60 });
                        if (re?.success) {
                            const newQid = opts.feed === 'following'
                                ? (re.homeLatestTimelineQueryId || re.homeTimelineQueryId)
                                : (re.homeTimelineQueryId || re.homeLatestTimelineQueryId);
                            if (newQid) {
                                graphqlParams.queryId = newQid;
                                graphqlParams.features = re.features || graphqlParams.features;
                                graphqlParams.variables = re.variables || graphqlParams.variables;
                                await saveGraphQLCache(cacheKey, graphqlParams);
                                page--; continue;
                            }
                        }
                    } catch (e) { log.warn(`⚠ 重新发现失败: ${e.message}`); }
                }
                if (statusCode === 429) {
                    consecutive429Count++;
                    if (consecutive429Count >= 3) {
                        await new Promise(r => setTimeout(r, 5 * 60 * 1000));
                        consecutive429Count = 0;
                        page--; continue;
                    }
                } else {
                    if (page === 1) graphqlFailed = true;
                    break;
                }
            }
            if (!graphqlResult || !graphqlResult.success) { if (page === 1) graphqlFailed = true; break; }
            consecutive429Count = 0;

            const { tweets: pageTweets, nextCursor } = graphqlResult;
            if (Array.isArray(pageTweets) && pageTweets.length > 0) {
                const filtered = H.filterTweets(pageTweets, opts);
                let newCount = 0;
                const newTweets = [];
                filtered.forEach(t => {
                    if (!seenIds.has(t.tweetId)) { seenIds.add(t.tweetId); allTweets.push(t); newTweets.push(t); newCount++; }
                });
                log.log(`✓ 第 ${page} 页: ${pageTweets.length} 条, ${newCount} 条新增, 累计 ${allTweets.length}`);
                if (opts._outputDir) await appendPartialTweets(opts._outputDir, newTweets);
                if (opts.maxTweets > 0 && allTweets.length >= opts.maxTweets) break;
            } else { break; }

            if (nextCursor) { cursor = nextCursor; } else { break; }
            if (page < opts.maxPages) {
                if (elapsed > 8000) pageDelay = Math.min(pageDelay * 1.5, MAX_PAGE_DELAY);
                else if (elapsed < 3000) pageDelay = Math.max(pageDelay * 0.9, MIN_PAGE_DELAY);
                await new Promise(r => setTimeout(r, pageDelay));
            }
        }

        // Phase 4: DOM 回退
        if (graphqlFailed && allTweets.length === 0) {
            log.log('回退到 DOM 提取...');
            const dom = await safeExecuteScript(tabId, H.buildHomeDomScript(), { timeout: 60 });
            if (dom?.success && dom.tweets?.length > 0) {
                const filtered = H.filterTweets(dom.tweets, opts);
                filtered.forEach(t => { if (!seenIds.has(t.tweetId)) { seenIds.add(t.tweetId); allTweets.push(t); } });
            }
        }

        await releaseXTab(browser, tabId, !opts.closeTab);
        tabId = null;

        let filteredTweets = allTweets;
        if (opts.minLikes > 0 || opts.minRetweets > 0) {
            filteredTweets = allTweets.filter(t => t.stats.likes >= opts.minLikes && t.stats.retweets >= opts.minRetweets);
        }
        if (opts.maxTweets > 0 && filteredTweets.length > opts.maxTweets) {
            filteredTweets = filteredTweets.slice(0, opts.maxTweets);
        }

        return {
            feed: opts.feed,
            scrapeOptions: {
                feed: opts.feed, maxPages: opts.maxPages, maxTweets: opts.maxTweets,
                minLikes: opts.minLikes, minRetweets: opts.minRetweets,
                excludeReplies: opts.excludeReplies, excludeRetweets: opts.excludeRetweets,
            },
            timestamp: new Date().toISOString(),
            totalResults: filteredTweets.length,
            results: filteredTweets,
        };
    } catch (err) {
        if (tabId) { try { await releaseXTab(browser, tabId); } catch (_) {} }
        throw err;
    }
}

module.exports = { searchTweets, getProfileTweets, getPost, getHomeFeed };
