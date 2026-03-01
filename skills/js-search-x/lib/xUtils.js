/**
 * X.com (Twitter) 共享工具模块
 * 
 * 提供 X.com 相关脚本（x-search.js、x-profile.js 等）的通用功能：
 * - GraphQL API 常量（features、bearer token）
 * - 浏览器端推文 DOM 解析代码片段
 * - 浏览器端 GraphQL 推文解析代码片段
 * - 带指数退避的重试函数
 * - 断点续传（进度保存/加载/追加/清理）
 * - 文件工具（目录创建、时间戳、保存）
 * - safeExecuteScript 封装
 */

const fs = require('fs').promises;
const path = require('path');
const { existsSync } = require('fs');

// ============================================================================
// 常量与默认配置
// ============================================================================

/**
 * X.com GraphQL API 所需的 features 参数默认值
 * 可能需要随 X 更新而调整；动态发现机制会尝试自动获取最新值
 */
const DEFAULT_GRAPHQL_FEATURES = {
    creator_subscriptions_tweet_preview_api_enabled: true,
    premium_content_api_read_enabled: false,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    responsive_web_grok_analyze_button_fetch_trends_enabled: false,
    responsive_web_grok_analyze_post_followups_enabled: false,
    responsive_web_jetfuel_frame: true,
    responsive_web_grok_share_attachment_enabled: true,
    responsive_web_grok_annotations_enabled: false,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    responsive_web_grok_show_grok_translated_post: false,
    responsive_web_grok_analysis_button_from_backend: true,
    post_ctas_fetch_enabled: true,
    creator_subscriptions_quote_tweet_preview_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    responsive_web_profile_redirect_enabled: false,
    rweb_tipjar_consumption_enabled: true,
    verified_phone_label_enabled: false,
    responsive_web_grok_image_annotation_enabled: true,
    responsive_web_grok_imagine_annotation_enabled: true,
    responsive_web_grok_community_note_auto_translation_is_enabled: false,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_enhance_cards_enabled: false,
    rweb_video_screen_enabled: true,
    rweb_video_timestamps_enabled: true
};

/**
 * X.com 用户相关 GraphQL API 所需的 features 参数默认值
 * 用于 UserByScreenName、UserTweets 等 API（与 SearchTimeline 的 features 不同）
 */
const DEFAULT_USER_FEATURES = {
    hidden_profile_subscriptions_enabled: true,
    rweb_tipjar_consumption_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    subscriptions_verification_info_is_identity_verified_enabled: true,
    subscriptions_verification_info_verified_since_enabled: true,
    highlights_tweets_tab_ui_enabled: true,
    responsive_web_twitter_article_notes_tab_enabled: true,
    subscriptions_feature_can_gift_premium: true,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_profile_redirect_enabled: false,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    creator_subscriptions_quote_tweet_preview_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    articles_preview_enabled: true,
    rweb_video_timestamps_enabled: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    communities_web_enable_tweet_community_results_fetch: true,
    premium_content_api_read_enabled: false,
    responsive_web_grok_analyze_button_fetch_trends_enabled: false,
    responsive_web_grok_analyze_post_followups_enabled: false,
    responsive_web_grok_share_attachment_enabled: true,
    responsive_web_grok_annotations_enabled: false,
    responsive_web_jetfuel_frame: true,
    responsive_web_grok_show_grok_translated_post: false,
    responsive_web_grok_analysis_button_from_backend: true,
    responsive_web_grok_image_annotation_enabled: true,
    responsive_web_grok_imagine_annotation_enabled: true,
    responsive_web_grok_community_note_auto_translation_is_enabled: false,
    rweb_video_screen_enabled: true,
    post_ctas_fetch_enabled: true,
    responsive_web_enhance_cards_enabled: false
};

/** X.com 公共 Bearer Token */
const BEARER_TOKEN = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

// ============================================================================
// Tab 注册表 + 文件锁（跨进程并发安全）
// ============================================================================

const { writeFileSync, unlinkSync, mkdirSync, readFileSync, openSync, closeSync } = require('fs');

/** 自增计数器，为每次 acquireXTab 调用自动分配唯一 taskId */
let _taskCounter = 0;

/** 僵尸占用超时阈值（毫秒）：超过此时间未释放的占用将被自动清理 */
const TAB_OCCUPY_TIMEOUT_MS = 30 * 60 * 1000; // 30 分钟

/** 文件锁超时阈值（毫秒）：锁文件存在超过此时间视为僵尸锁 */
const FILE_LOCK_TIMEOUT_MS = 30 * 1000; // 30 秒

/** 文件锁重试间隔（毫秒） */
const FILE_LOCK_RETRY_INTERVAL_MS = 50;

/** 文件锁最大等待时间（毫秒） */
const FILE_LOCK_MAX_WAIT_MS = 10 * 1000; // 10 秒

/** 注册表文件路径 */
const REGISTRY_DIR = path.join(process.cwd(), 'work_dir', 'cache');
const REGISTRY_FILE = path.join(REGISTRY_DIR, 'tab_registry.json');
const REGISTRY_LOCK = path.join(REGISTRY_DIR, 'tab_registry.lock');

/** 当前进程的 PID，用于标识注册表条目的归属 */
const CURRENT_PID = process.pid;

/**
 * 确保注册表目录存在
 */
function _ensureRegistryDir() {
    if (!existsSync(REGISTRY_DIR)) {
        mkdirSync(REGISTRY_DIR, { recursive: true });
    }
}

/**
 * 获取文件锁（跨进程互斥）
 * 
 * 使用 fs.openSync + 'wx' 独占标志实现原子性创建。
 * 锁文件中写入 PID 和时间戳，支持僵尸锁检测。
 * 
 * @returns {Promise<void>}
 * @throws {Error} 超时未获取到锁
 */
async function _acquireFileLock() {
    _ensureRegistryDir();
    const startTime = Date.now();
    
    while (true) {
        try {
            // 'wx' 标志：独占创建，文件已存在则抛 EEXIST
            const fd = openSync(REGISTRY_LOCK, 'wx');
            writeFileSync(fd, JSON.stringify({ pid: CURRENT_PID, time: Date.now() }));
            closeSync(fd);
            return; // 成功获取锁
        } catch (err) {
            if (err.code !== 'EEXIST') throw err;
            
            // 锁文件已存在 —— 检查是否为僵尸锁
            try {
                const lockData = JSON.parse(readFileSync(REGISTRY_LOCK, 'utf-8'));
                const lockAge = Date.now() - lockData.time;
                
                if (lockAge > FILE_LOCK_TIMEOUT_MS) {
                    // 僵尸锁：持有时间超过阈值，强制清除
                    console.warn(`⚠ [TabRegistry] 清除僵尸锁（pid=${lockData.pid}, 已持有 ${Math.round(lockAge / 1000)}s）`);
                    try { unlinkSync(REGISTRY_LOCK); } catch (e) { /* 忽略 */ }
                    continue; // 重试获取
                }
            } catch (readErr) {
                // 锁文件读取失败（可能正在被写入），等待后重试
            }
            
            // 检查是否超时
            if (Date.now() - startTime > FILE_LOCK_MAX_WAIT_MS) {
                throw new Error(`[TabRegistry] 获取文件锁超时（等待 ${FILE_LOCK_MAX_WAIT_MS}ms）`);
            }
            
            // 等待后重试
            await new Promise(resolve => setTimeout(resolve, FILE_LOCK_RETRY_INTERVAL_MS));
        }
    }
}

/**
 * 释放文件锁
 */
function _releaseFileLock() {
    try { unlinkSync(REGISTRY_LOCK); } catch (e) { /* 忽略 */ }
}

/**
 * 带文件锁执行操作（跨进程互斥）
 * 
 * 同时包含进程内 Promise 链锁，确保同一进程内的并发调用也是串行的。
 * 
 * @param {Function} fn - 要在锁保护下执行的异步函数
 * @returns {Promise<*>} fn 的返回值
 */
let _mutexChain = Promise.resolve();
function withMutex(fn) {
    const wrapped = async () => {
        await _acquireFileLock();
        try {
            return await fn();
        } finally {
            _releaseFileLock();
        }
    };
    const p = _mutexChain.then(wrapped, wrapped);
    _mutexChain = p.catch(() => {});
    return p;
}

/**
 * 从文件读取注册表
 * @returns {Object} key: tabId(string) → { taskId, url, acquiredAt, pid }
 */
function _readRegistry() {
    try {
        if (!existsSync(REGISTRY_FILE)) return {};
        const data = readFileSync(REGISTRY_FILE, 'utf-8');
        return JSON.parse(data);
    } catch (err) {
        console.warn(`⚠ [TabRegistry] 读取注册表失败，返回空表: ${err.message}`);
        return {};
    }
}

/**
 * 将注册表写入文件
 * @param {Object} registry - 注册表对象
 */
function _writeRegistry(registry) {
    _ensureRegistryDir();
    writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf-8');
}

/**
 * 检查 tabId 是否在注册表中被占用
 * @param {Object} registry - 注册表对象
 * @param {number|string} tabId
 * @returns {boolean}
 */
function _isOccupied(registry, tabId) {
    return registry.hasOwnProperty(String(tabId));
}

/**
 * 向注册表中添加占用记录
 * @param {Object} registry - 注册表对象
 * @param {number} tabId
 * @param {Object} entry - { taskId, url, acquiredAt, pid }
 */
function _setEntry(registry, tabId, entry) {
    registry[String(tabId)] = entry;
}

/**
 * 从注册表中删除占用记录
 * @param {Object} registry - 注册表对象
 * @param {number|string} tabId
 * @returns {Object|undefined} 被删除的条目
 */
function _deleteEntry(registry, tabId) {
    const key = String(tabId);
    const entry = registry[key];
    delete registry[key];
    return entry;
}

/**
 * 清理僵尸占用：自动释放超过 TAB_OCCUPY_TIMEOUT_MS 未释放的注册条目
 * 在锁保护下调用，防止脚本异常退出后 tab 永久锁死。
 * @param {Object} registry - 注册表对象（会被就地修改）
 */
function _cleanupStaleEntries(registry) {
    const now = Date.now();
    for (const [tabId, entry] of Object.entries(registry)) {
        if (now - entry.acquiredAt > TAB_OCCUPY_TIMEOUT_MS) {
            console.warn(`⚠ Tab 注册表：清理僵尸占用 tab=${tabId}, task=${entry.taskId}, pid=${entry.pid}（已占用 ${Math.round((now - entry.acquiredAt) / 60000)} 分钟）`);
            delete registry[tabId];
        }
    }
}

/**
 * 获取注册表状态摘要（调试用）
 * @param {Object} registry - 注册表对象
 * @returns {string}
 */
function _registryStatus(registry) {
    const keys = Object.keys(registry);
    if (keys.length === 0) return '注册表为空';
    const entries = [];
    for (const [tabId, entry] of Object.entries(registry)) {
        const age = Math.round((Date.now() - entry.acquiredAt) / 1000);
        entries.push(`tab=${tabId}(task=${entry.taskId}, pid=${entry.pid}, ${age}s)`);
    }
    return `占用中: [${entries.join(', ')}]`;
}

// 进程退出时清理本进程的注册条目
process.on('exit', () => {
    try {
        if (!existsSync(REGISTRY_FILE)) return;
        const registry = JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8'));
        let cleaned = 0;
        for (const [tabId, entry] of Object.entries(registry)) {
            if (entry.pid === CURRENT_PID) {
                delete registry[tabId];
                cleaned++;
            }
        }
        if (cleaned > 0) {
            console.log(`[TabRegistry] 进程 ${CURRENT_PID} 退出，清理 ${cleaned} 个残留占用`);
            writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf-8');
        }
    } catch (e) {
        // exit 回调中不宜抛错
    }
    // 如果本进程持有锁文件也一并清理
    _releaseFileLock();
});

// ============================================================================
// 浏览器端推文 DOM 解析代码片段
// ============================================================================

/**
 * 返回推文 DOM 解析的 JS 代码片段（字符串），供多处拼接使用。
 * 
 * 生成的代码定义了两个函数：
 * - parseStatNumber(text)         解析互动数据中的数字（如 "1,234 likes" -> 1234）
 * - parseTweetArticle(article)    从 article DOM 元素解析出推文对象，失败返回 null
 */
function buildTweetParserSnippet() {
    return `
    const parseStatNumber = (text) => {
        if (!text) return 0;
        const match = text.match(/([\\d,.]+[KMB]?)\\s/i);
        if (!match) return 0;
        let numStr = match[1].replace(/,/g, '');
        const multiplier = numStr.match(/[KMB]$/i);
        if (multiplier) {
            numStr = numStr.replace(/[KMB]$/i, '');
            const num = parseFloat(numStr);
            switch (multiplier[0].toUpperCase()) {
                case 'K': return Math.round(num * 1000);
                case 'M': return Math.round(num * 1000000);
                case 'B': return Math.round(num * 1000000000);
            }
        }
        return parseInt(numStr, 10) || 0;
    };

    const parseTweetArticle = (article) => {
        // ---- 提取 tweetId 和 URL ----
        let tweetId = '';
        let tweetUrl = '';
        let authorUsername = '';

        const statusLinks = article.querySelectorAll('a[href*="/status/"]');
        for (const link of statusLinks) {
            const href = link.getAttribute('href') || '';
            const match = href.match(/^\\/([\\w]+)\\/status\\/(\\d+)/);
            if (match) {
                authorUsername = match[1];
                tweetId = match[2];
                tweetUrl = 'https://x.com' + href;
                break;
            }
        }

        if (!tweetId) return null;

        // 跳过广告推文
        const isPromoted = article.querySelector('[data-testid="placementTracking"]') !== null
            || article.innerText.includes('Promoted')
            || article.innerText.includes('推广');
        if (isPromoted) return null;

        // ---- 提取作者信息 ----
        let authorName = '';
        let authorAvatar = '';

        const userNameElem = article.querySelector('[data-testid="User-Name"]');
        if (userNameElem) {
            const spans = userNameElem.querySelectorAll('span');
            for (const span of spans) {
                const text = span.textContent.trim();
                if (text.startsWith('@')) {
                    authorUsername = text;
                    break;
                }
            }
            for (const span of spans) {
                const text = span.textContent.trim();
                if (text && !text.startsWith('@') && text.length > 0 && text.length < 60) {
                    if (!/^[\\d.,]+[万亿KMB]?$/.test(text) && !/^\\d+[hm]$/.test(text)) {
                        authorName = text;
                        break;
                    }
                }
            }
        }

        if (authorUsername && !authorUsername.startsWith('@')) {
            authorUsername = '@' + authorUsername;
        }

        const avatarImg = article.querySelector('img[src*="pbs.twimg.com/profile_images"]');
        if (avatarImg) authorAvatar = avatarImg.getAttribute('src') || '';

        // ---- 提取推文内容 ----
        let content = '';
        const tweetTextElem = article.querySelector('[data-testid="tweetText"]');
        if (tweetTextElem) content = tweetTextElem.textContent.trim();

        // ---- 提取时间戳 ----
        let publishTime = '';
        const timeElem = article.querySelector('time');
        if (timeElem) publishTime = timeElem.getAttribute('datetime') || '';

        // ---- 提取互动数据 ----
        const stats = { replies: 0, retweets: 0, likes: 0, views: 0, bookmarks: 0 };

        const replyBtn = article.querySelector('[data-testid="reply"]');
        const retweetBtn = article.querySelector('[data-testid="retweet"]');
        const likeBtn = article.querySelector('[data-testid="like"]') || article.querySelector('[data-testid="unlike"]');
        const bookmarkBtn = article.querySelector('[data-testid="bookmark"]') || article.querySelector('[data-testid="removeBookmark"]');

        if (replyBtn) stats.replies = parseStatNumber(replyBtn.getAttribute('aria-label'));
        if (retweetBtn) stats.retweets = parseStatNumber(retweetBtn.getAttribute('aria-label'));
        if (likeBtn) stats.likes = parseStatNumber(likeBtn.getAttribute('aria-label'));
        if (bookmarkBtn) stats.bookmarks = parseStatNumber(bookmarkBtn.getAttribute('aria-label'));

        const analyticsLink = article.querySelector('a[href*="/analytics"]');
        if (analyticsLink) stats.views = parseStatNumber(analyticsLink.getAttribute('aria-label'));

        // ---- 提取媒体 URL ----
        const mediaUrls = [];
        article.querySelectorAll('img[src*="pbs.twimg.com/media"]').forEach(img => {
            const src = img.getAttribute('src');
            if (src) mediaUrls.push(src);
        });
        article.querySelectorAll('video[poster]').forEach(video => {
            const poster = video.getAttribute('poster');
            if (poster) mediaUrls.push(poster);
        });

        return {
            tweetId,
            author: { name: authorName, username: authorUsername, avatarUrl: authorAvatar },
            content, publishTime, stats,
            mediaUrls: [...new Set(mediaUrls)],
            tweetUrl
        };
    };`;
}

// ============================================================================
// 浏览器端 GraphQL 推文解析代码片段
// ============================================================================

/**
 * 返回从 GraphQL timeline entries 中解析推文的 JS 代码片段（字符串）。
 * 
 * 生成的代码定义了一个函数：
 * - parseTweetEntries(entries)  从 timeline entries 数组中提取推文和下一页游标
 *   返回 { tweets: Array, nextCursor: string|null }
 * 
 * 适用于 SearchTimeline、UserTweets 等共享同一 entry 结构的 GraphQL API。
 */
function buildGraphQLTweetParserSnippet() {
    return `
    const parseTweetEntries = (entries) => {
        const tweets = [];
        let nextCursor = null;
        
        for (const entry of entries) {
            const entryId = entry.entryId || '';
            
            // 提取下一页游标
            if (entryId.startsWith('cursor-bottom')) {
                nextCursor = entry.content?.value || null;
                continue;
            }
            
            // 跳过非推文 entry（profile-conversation、who-to-follow 等也用 tweet- 前缀以外的 id）
            if (!entryId.startsWith('tweet-') && !entryId.startsWith('profile-conversation')) continue;
            
            // profile-conversation 类型包含多条推文
            if (entryId.startsWith('profile-conversation')) {
                const items = entry.content?.items || [];
                for (const item of items) {
                    const tweetResult = item.item?.itemContent?.tweet_results?.result;
                    if (tweetResult) {
                        const parsed = parseSingleTweetResult(tweetResult);
                        if (parsed) tweets.push(parsed);
                    }
                }
                continue;
            }
            
            const tweetResult = entry.content?.itemContent?.tweet_results?.result;
            if (!tweetResult) continue;
            
            const parsed = parseSingleTweetResult(tweetResult);
            if (parsed) tweets.push(parsed);
        }
        
        return { tweets, nextCursor };
    };
    
    const parseSingleTweetResult = (tweetResult) => {
        // 处理 TweetWithVisibilityResults 包装
        const actualTweet = tweetResult.tweet || tweetResult;
        const legacy = actualTweet.legacy;
        if (!legacy) return null;
        
        // 跳过广告
        if (actualTweet.promotedMetadata) return null;
        
        const userResult = actualTweet.core?.user_results?.result;
        const userLegacy = userResult?.legacy;
        const userCore = userResult?.core;
        const userAvatar = userResult?.avatar;
        
        // 提取媒体 URL
        const mediaUrls = [];
        const mediaEntities = legacy.extended_entities?.media || legacy.entities?.media || [];
        mediaEntities.forEach(media => {
            if (media.type === 'photo' && media.media_url_https) {
                mediaUrls.push(media.media_url_https);
            } else if ((media.type === 'video' || media.type === 'animated_gif') && media.video_info?.variants) {
                const mp4s = media.video_info.variants
                    .filter(v => v.content_type === 'video/mp4')
                    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
                if (mp4s.length > 0) {
                    mediaUrls.push(mp4s[0].url);
                }
            }
        });
        
        // 兼容新旧两种用户信息结构：
        // 新版：name/screen_name 在 core 中，avatar 在 avatar.image_url
        // 旧版：全部在 legacy 中
        const screenName = userCore?.screen_name || userLegacy?.screen_name || '';
        const tweetId = legacy.id_str || actualTweet.rest_id || '';
        
        return {
            tweetId: tweetId,
            author: {
                name: userCore?.name || userLegacy?.name || '',
                username: '@' + screenName,
                avatarUrl: userAvatar?.image_url || userLegacy?.profile_image_url_https || ''
            },
            content: legacy.full_text || '',
            publishTime: legacy.created_at || '',
            stats: {
                replies: legacy.reply_count || 0,
                retweets: legacy.retweet_count || 0,
                likes: legacy.favorite_count || 0,
                views: parseInt(actualTweet.views?.count, 10) || 0,
                bookmarks: legacy.bookmark_count || 0
            },
            mediaUrls: [...new Set(mediaUrls)],
            tweetUrl: screenName && tweetId ? ('https://x.com/' + screenName + '/status/' + tweetId) : '',
            isRetweet: !!legacy.retweeted_status_result,
            isReply: !!legacy.in_reply_to_status_id_str,
            inReplyToTweetId: legacy.in_reply_to_status_id_str || null
        };
    };`;
}

// ============================================================================
// 通用重试工具
// ============================================================================

/**
 * 带指数退避的重试函数
 * @param {Function} fn - 要执行的异步函数，接收 attempt 参数（从 0 开始）
 * @param {Object} [options] - 重试选项
 * @param {number} [options.maxRetries=3] - 最大重试次数
 * @param {number} [options.baseDelay=2000] - 基础延迟（毫秒）
 * @param {number} [options.maxDelay=16000] - 最大延迟（毫秒）
 * @param {Function} [options.shouldRetry] - 判断是否应该重试的函数
 * @param {Function} [options.onRetry] - 重试前的回调
 * @returns {Promise<any>} 执行结果
 */
async function retryWithBackoff(fn, options = {}) {
    const {
        maxRetries = 3,
        baseDelay = 2000,
        maxDelay = 16000,
        shouldRetry = () => true,
        onRetry = () => {}
    } = options;
    
    let lastError;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const result = await fn(attempt);
            
            // 检查 GraphQL 返回的逻辑错误（非 throw 的错误）
            if (result && !result.success && result.statusCode) {
                const isRetryable = result.statusCode === 429 || result.statusCode >= 500;
                if (isRetryable && attempt < maxRetries && shouldRetry(result, attempt)) {
                    // 429 有 retryAfter 则使用，否则指数退避
                    let delay;
                    if (result.statusCode === 429 && result.retryAfter) {
                        delay = result.retryAfter * 1000;
                    } else {
                        delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
                    }
                    onRetry(attempt + 1, delay, result);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                }
            }
            
            return result;
        } catch (error) {
            lastError = error;
            
            if (attempt < maxRetries && shouldRetry(error, attempt)) {
                const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
                onRetry(attempt + 1, delay, error);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    
    throw lastError;
}

// ============================================================================
// 进度管理（断点续传）
// ============================================================================

/**
 * 保存进度到 state.json
 * @param {string} outputDir - 输出目录路径
 * @param {Object} state - 进度状态对象
 */
async function saveProgress(outputDir, state) {
    const statePath = path.join(outputDir, 'state.json');
    await ensureDirectoryExists(outputDir);
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * 加载进度
 * @param {string} outputDir - 输出目录路径
 * @returns {Object|null} 进度对象，不存在则返回 null
 */
async function loadProgress(outputDir) {
    const statePath = path.join(outputDir, 'state.json');
    if (!existsSync(statePath)) return null;
    
    try {
        const data = await fs.readFile(statePath, 'utf-8');
        return JSON.parse(data);
    } catch (e) {
        console.warn(`⚠ 读取进度文件失败: ${e.message}`);
        return null;
    }
}

/**
 * 追加推文到 partial JSONL 文件（每行一条推文 JSON）
 * @param {string} outputDir - 输出目录路径
 * @param {Array} tweets - 推文数组
 */
async function appendPartialTweets(outputDir, tweets) {
    if (!tweets || tweets.length === 0) return;
    const partialPath = path.join(outputDir, 'data.partial.jsonl');
    await ensureDirectoryExists(outputDir);
    const lines = tweets.map(t => JSON.stringify(t)).join('\n') + '\n';
    await fs.appendFile(partialPath, lines, 'utf-8');
}

/**
 * 从 partial JSONL 文件读取已保存的推文
 * @param {string} outputDir - 输出目录路径
 * @returns {Array} 推文数组
 */
async function loadPartialTweets(outputDir) {
    const partialPath = path.join(outputDir, 'data.partial.jsonl');
    if (!existsSync(partialPath)) return [];
    
    try {
        const data = await fs.readFile(partialPath, 'utf-8');
        return data.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    } catch (e) {
        console.warn(`⚠ 读取部分结果文件失败: ${e.message}`);
        return [];
    }
}

/**
 * 清理临时文件（state.json 和 data.partial.jsonl）
 * @param {string} outputDir - 输出目录路径
 */
async function cleanupTempFiles(outputDir) {
    const files = ['state.json', 'data.partial.jsonl'];
    for (const file of files) {
        const filePath = path.join(outputDir, file);
        try {
            if (existsSync(filePath)) {
                await fs.unlink(filePath);
            }
        } catch (e) {
            // 忽略清理失败
        }
    }
}

// ============================================================================
// 文件工具
// ============================================================================

async function ensureDirectoryExists(dirPath) {
    try {
        if (!existsSync(dirPath)) {
            await fs.mkdir(dirPath, { recursive: true });
            console.log(`已创建目录: ${dirPath}`);
        }
    } catch (error) {
        console.error(`创建目录失败: ${error.message}`);
        throw error;
    }
}

function generateTimestamp() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const h = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    return `${y}-${m}-${d}T${h}-${min}-${s}`;
}

async function saveToFile(filePath, data) {
    try {
        const dir = path.dirname(filePath);
        await ensureDirectoryExists(dir);
        await fs.writeFile(filePath, data, 'utf-8');
        console.log(`\n结果已保存到: ${filePath}`);
    } catch (error) {
        console.error(`保存文件失败: ${error.message}`);
        throw error;
    }
}

// ============================================================================
// 页面加载等待（替代旧版 waitForTabReady 事件订阅）
// ============================================================================

/**
 * 等待页面加载完成，通过 executeScript 轮询 document.readyState。
 * 
 * @param {Object} browser - BrowserAutomation 实例（JS-Eyes SDK）
 * @param {number} tabId - 标签页 ID
 * @param {Object} [options]
 * @param {number} [options.timeout=30000] - 超时时间（毫秒）
 * @param {number} [options.pollInterval=1000] - 轮询间隔（毫秒）
 * @returns {Promise<void>}
 */
async function waitForPageLoad(browser, tabId, options = {}) {
    const { timeout = 30000, pollInterval = 1500 } = options;
    const startTime = Date.now();
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    while (Date.now() - startTime < timeout) {
        try {
            const readyState = await browser.executeScript(tabId, 'document.readyState', { timeout: 5 });
            if (readyState === 'complete') return;
        } catch (e) {
            // 页面可能还在导航中，忽略错误继续轮询
        }
        await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
    
    throw new Error(`等待页面加载超时 (${timeout}ms)`);
}

// ============================================================================
// safeExecuteScript 工厂
// ============================================================================

/**
 * 创建 safeExecuteScript 函数。
 * 
 * JS-Eyes SDK 支持单连接多次 executeScript，无需旧版的 disconnect/reconnect hack。
 * 保留连接级别的重试以应对偶发网络问题。
 * 
 * @param {Object} browser - BrowserAutomation 实例（JS-Eyes SDK）
 * @returns {Function} safeExecuteScript(tabId, code, opts) => Promise<any>
 */
function createSafeExecuteScript(browser) {
    return async function safeExecuteScript(targetTabId, code, opts = {}) {
        const maxAttempts = 3;
        let lastError;
        
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                return await browser.executeScript(targetTabId, code, opts);
            } catch (error) {
                lastError = error;
                const errMsg = error.message || String(error);
                
                if (errMsg.includes('脚本执行错误') || errMsg.includes('Script execution error')) {
                    throw error;
                }
                
                if (attempt < maxAttempts - 1) {
                    const waitMs = 1000 + attempt * 1000;
                    await new Promise(resolve => setTimeout(resolve, waitMs));
                }
            }
        }
        
        throw lastError;
    };
}

// ============================================================================
// 推文摘要打印
// ============================================================================

/**
 * 打印推文统计摘要
 * @param {Array} filteredTweets - 推文数组
 * @param {string} [title='完成'] - 摘要标题
 */
function printSummary(filteredTweets, title = '完成') {
    console.log('\n' + '='.repeat(60));
    console.log(title);
    console.log('='.repeat(60));
    console.log(`总计结果: ${filteredTweets.length} 条推文`);
    
    if (filteredTweets.length > 0) {
        const totalLikes = filteredTweets.reduce((sum, t) => sum + t.stats.likes, 0);
        const totalRetweets = filteredTweets.reduce((sum, t) => sum + t.stats.retweets, 0);
        const avgLikes = Math.round(totalLikes / filteredTweets.length);
        const maxLikes = Math.max(...filteredTweets.map(t => t.stats.likes));
        
        console.log(`总点赞数: ${totalLikes.toLocaleString()}`);
        console.log(`总转发数: ${totalRetweets.toLocaleString()}`);
        console.log(`平均点赞: ${avgLikes.toLocaleString()}`);
        console.log(`最高点赞: ${maxLikes.toLocaleString()}`);
        
        console.log('\n热门推文预览:');
        const topTweets = [...filteredTweets].sort((a, b) => b.stats.likes - a.stats.likes).slice(0, 3);
        topTweets.forEach((tweet, i) => {
            const contentPreview = tweet.content.substring(0, 80) + (tweet.content.length > 80 ? '...' : '');
            console.log(`  ${i + 1}. [${tweet.stats.likes} likes] ${tweet.author.username}: ${contentPreview}`);
        });
    }
    
    console.log('='.repeat(60));
}

// ============================================================================
// 域级别 Tab 复用
// ============================================================================

/**
 * 获取或复用 x.com 域名下的浏览器标签页（并发安全）
 * 
 * 使用互斥锁 + 注册表确保多任务并发时不会争抢同一个 tab。
 * 
 * 优先级：
 * 1. URL 与 targetUrl 完全匹配且未被占用 → 直接复用，无需导航
 * 2. URL 在 x.com 域名下但路径不同且未被占用 → 复用 tab，在同 tab 内导航（SPA 内跳转）
 * 3. 无可用 x.com tab → 新建 tab（冷启动）
 * 
 * @param {Object} browser - BrowserAutomation 实例
 * @param {string} targetUrl - 目标 URL（如 https://x.com/home）
 * @param {Object} [options] - 可选配置
 * @param {string} [options.taskId] - 任务 ID（不传则自动生成）
 * @returns {Promise<{ tabId: number, isReused: boolean, navigated: boolean, taskId: string }>}
 */
async function acquireXTab(browser, targetUrl, options = {}) {
    const taskId = options.taskId || `task_${++_taskCounter}`;
    
    return withMutex(async () => {
        try {
            // 从文件读取注册表并清理僵尸占用
            const registry = _readRegistry();
            _cleanupStaleEntries(registry);
            
            const tabsResult = await browser.getTabs();
            
            if (tabsResult && tabsResult.tabs) {
                let exactMatch = null;
                let domainMatch = null;
                const normalizeUrl = u => u.replace(/\/+$/, '');
                
                for (const tab of tabsResult.tabs) {
                    const tabUrl = tab.url || '';
                    
                    // 跳过已被其他任务占用的 tab
                    if (_isOccupied(registry, tab.id)) {
                        continue;
                    }
                    
                    // 优先级 1：URL 完全匹配（忽略尾部斜杠差异）
                    if (normalizeUrl(tabUrl) === normalizeUrl(targetUrl)) {
                        exactMatch = tab;
                        break;
                    }
                    
                    // 优先级 2：同域名匹配（x.com 或 twitter.com）
                    if (!domainMatch && (tabUrl.includes('x.com/') || tabUrl.includes('twitter.com/'))) {
                        domainMatch = tab;
                    }
                }
                
                if (exactMatch) {
                    // 注册占用并写入文件
                    _setEntry(registry, exactMatch.id, { taskId, url: targetUrl, acquiredAt: Date.now(), pid: CURRENT_PID });
                    _writeRegistry(registry);
                    console.log(`✓ [${taskId}] 复用已有标签页 ${exactMatch.id}（URL 完全匹配）| ${_registryStatus(registry)}`);
                    return { tabId: exactMatch.id, isReused: true, navigated: false, taskId };
                }
                
                if (domainMatch) {
                    // 注册占用并写入文件
                    _setEntry(registry, domainMatch.id, { taskId, url: targetUrl, acquiredAt: Date.now(), pid: CURRENT_PID });
                    _writeRegistry(registry);
                    console.log(`✓ [${taskId}] 复用同域标签页 ${domainMatch.id}，从 ${domainMatch.url.substring(0, 60)} 导航到目标页 | ${_registryStatus(registry)}`);
                    await browser.openUrl(targetUrl, domainMatch.id);
                    return { tabId: domainMatch.id, isReused: true, navigated: true, taskId };
                }
            }
            
            // 优先级 3：无匹配或无可用（未占用）tab，新建标签页
            console.log(`[${taskId}] 创建新标签页...`);
            const tabId = await browser.openUrl(targetUrl);
            // 注册占用并写入文件
            _setEntry(registry, tabId, { taskId, url: targetUrl, acquiredAt: Date.now(), pid: CURRENT_PID });
            _writeRegistry(registry);
            console.log(`✓ [${taskId}] 新建标签页 ${tabId} | ${_registryStatus(registry)}`);
            return { tabId, isReused: false, navigated: false, taskId };
        } catch (error) {
            console.error(`[${taskId}] acquireXTab 失败: ${error.message}`);
            throw error;
        }
    });
}

/**
 * 释放浏览器标签页
 * 
 * 从注册表中移除占用记录，使 tab 可被其他任务复用。
 * 
 * @param {Object} browser - BrowserAutomation 实例
 * @param {number} tabId - 标签页 ID
 * @param {boolean} [keepAlive=true] - 是否保留 tab（仅断开连接）
 */
async function releaseXTab(browser, tabId, keepAlive = true) {
    // 从文件注册表中释放占用（带文件锁保护）
    let taskLabel = 'unknown';
    try {
        await _acquireFileLock();
        try {
            const registry = _readRegistry();
            const entry = _deleteEntry(registry, tabId);
            taskLabel = entry ? entry.taskId : 'unknown';
            _writeRegistry(registry);
        } finally {
            _releaseFileLock();
        }
    } catch (lockErr) {
        console.warn(`⚠ [TabRegistry] release 时获取锁失败，尝试直接清理: ${lockErr.message}`);
        // 降级：尝试不加锁直接清理（总比不清理好）
        try {
            const registry = _readRegistry();
            const entry = _deleteEntry(registry, tabId);
            taskLabel = entry ? entry.taskId : 'unknown';
            _writeRegistry(registry);
        } catch (e) { /* 忽略 */ }
    }
    
    try {
        if (keepAlive) {
            console.log(`✓ [${taskLabel}] 标签页 ${tabId} 保留供下次复用`);
        } else {
            await browser.closeTab(tabId);
            console.log(`✓ [${taskLabel}] 已关闭标签页 ${tabId}`);
        }
    } catch (error) {
        console.warn(`⚠ [${taskLabel}] 释放标签页失败: ${error.message}`);
    }
}

// ============================================================================
// GraphQL 参数缓存
// ============================================================================

/** GraphQL 参数缓存有效期（24 小时） */
const GRAPHQL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 加载 GraphQL 参数缓存
 * @param {string} apiName - API 名称（如 'HomeTimeline'）
 * @returns {Promise<Object|null>} 缓存对象（含 queryId, features），过期或不存在返回 null
 */
async function loadGraphQLCache(apiName) {
    const cachePath = path.join(process.cwd(), 'work_dir', 'cache', `x_graphql_params_${apiName}.json`);
    
    if (!existsSync(cachePath)) return null;
    
    try {
        const data = await fs.readFile(cachePath, 'utf-8');
        const cache = JSON.parse(data);
        
        // 检查是否过期
        if (cache.savedAt) {
            const age = Date.now() - new Date(cache.savedAt).getTime();
            if (age > GRAPHQL_CACHE_TTL_MS) {
                console.log(`GraphQL 缓存已过期 (${Math.round(age / 3600000)}h)，将重新发现`);
                return null;
            }
        }
        
        console.log(`✓ 加载 GraphQL 缓存: ${apiName} (queryId: ${cache.queryId || '无'})`);
        return cache;
    } catch (e) {
        console.warn(`⚠ 读取 GraphQL 缓存失败: ${e.message}`);
        return null;
    }
}

/**
 * 保存 GraphQL 参数缓存
 * @param {string} apiName - API 名称（如 'HomeTimeline'）
 * @param {Object} params - 要缓存的参数（queryId, features 等）
 */
async function saveGraphQLCache(apiName, params) {
    const cacheDir = path.join(process.cwd(), 'work_dir', 'cache');
    const cachePath = path.join(cacheDir, `x_graphql_params_${apiName}.json`);
    
    try {
        await ensureDirectoryExists(cacheDir);
        const cacheData = {
            ...params,
            savedAt: new Date().toISOString()
        };
        await fs.writeFile(cachePath, JSON.stringify(cacheData, null, 2), 'utf-8');
        console.log(`✓ 已保存 GraphQL 缓存: ${apiName}`);
    } catch (e) {
        console.warn(`⚠ 保存 GraphQL 缓存失败: ${e.message}`);
    }
}

/**
 * 清除 GraphQL 参数缓存
 * @param {string} apiName - API 名称
 */
async function clearGraphQLCache(apiName) {
    const cachePath = path.join(process.cwd(), 'work_dir', 'cache', `x_graphql_params_${apiName}.json`);
    try {
        if (existsSync(cachePath)) {
            await fs.unlink(cachePath);
            console.log(`✓ 已清除 GraphQL 缓存: ${apiName}`);
        }
    } catch (e) {
        // 忽略
    }
}

// ============================================================================
// 导出
// ============================================================================

module.exports = {
    // 常量
    DEFAULT_GRAPHQL_FEATURES,
    DEFAULT_USER_FEATURES,
    BEARER_TOKEN,
    
    // 浏览器端代码片段
    buildTweetParserSnippet,
    buildGraphQLTweetParserSnippet,
    
    // 重试
    retryWithBackoff,
    
    // 断点续传
    saveProgress,
    loadProgress,
    appendPartialTweets,
    loadPartialTweets,
    cleanupTempFiles,
    
    // 文件工具
    ensureDirectoryExists,
    generateTimestamp,
    saveToFile,
    
    // 浏览器工具
    waitForPageLoad,
    createSafeExecuteScript,
    
    // Tab 复用
    acquireXTab,
    releaseXTab,
    
    // GraphQL 缓存
    loadGraphQLCache,
    saveGraphQLCache,
    clearGraphQLCache,
    
    // 输出
    printSummary
};
