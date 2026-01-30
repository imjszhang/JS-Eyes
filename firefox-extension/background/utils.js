/**
 * Firefox 扩展工具函数模块
 * 
 * 提供超时控制、速率限制、请求去重等功能
 * 用于提高扩展的稳定性和健壮性
 */

/**
 * Promise 超时包装器
 * 为任何 Promise 添加超时限制，超时后自动 reject
 * 
 * @param {Promise} promise - 要包装的 Promise
 * @param {number} ms - 超时时间（毫秒）
 * @param {string} errorMessage - 超时错误信息
 * @returns {Promise} - 带超时限制的 Promise
 */
async function withTimeout(promise, ms, errorMessage = '操作超时') {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${errorMessage} (${ms}ms)`));
    }, ms);
  });
  
  try {
    const result = await Promise.race([promise, timeoutPromise]);
    return result;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * 滑动窗口速率限制器
 * 限制单位时间内的请求数量
 */
class RateLimiter {
  /**
   * @param {number} maxRequests - 时间窗口内允许的最大请求数
   * @param {number} windowMs - 时间窗口大小（毫秒）
   * @param {number} blockDuration - 超限后阻止时间（毫秒）
   */
  constructor(maxRequests = 10, windowMs = 1000, blockDuration = 5000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.blockDuration = blockDuration;
    this.timestamps = [];
    this.blockedUntil = 0;
  }

  /**
   * 检查是否允许新请求
   * @returns {Object} { allowed: boolean, retryAfter?: number }
   */
  check() {
    const now = Date.now();
    
    // 检查是否在阻止期内
    if (now < this.blockedUntil) {
      const retryAfter = Math.ceil((this.blockedUntil - now) / 1000);
      return { 
        allowed: false, 
        retryAfter,
        reason: `请求频率过高，请在 ${retryAfter} 秒后重试`
      };
    }
    
    // 清理过期的时间戳
    this.timestamps = this.timestamps.filter(
      ts => now - ts < this.windowMs
    );
    
    // 检查是否超过限制
    if (this.timestamps.length >= this.maxRequests) {
      // 进入阻止期
      this.blockedUntil = now + this.blockDuration;
      const retryAfter = Math.ceil(this.blockDuration / 1000);
      console.warn(`[RateLimiter] 请求频率超限，已阻止 ${retryAfter} 秒`);
      return { 
        allowed: false, 
        retryAfter,
        reason: `请求频率超限（${this.maxRequests}次/${this.windowMs}ms），已阻止 ${retryAfter} 秒`
      };
    }
    
    // 记录本次请求
    this.timestamps.push(now);
    return { allowed: true };
  }

  /**
   * 获取当前状态
   */
  getStatus() {
    const now = Date.now();
    this.timestamps = this.timestamps.filter(ts => now - ts < this.windowMs);
    
    return {
      currentRequests: this.timestamps.length,
      maxRequests: this.maxRequests,
      windowMs: this.windowMs,
      isBlocked: now < this.blockedUntil,
      blockedUntil: this.blockedUntil > now ? this.blockedUntil : null
    };
  }

  /**
   * 重置限制器
   */
  reset() {
    this.timestamps = [];
    this.blockedUntil = 0;
    console.log('[RateLimiter] 已重置');
  }
}

/**
 * 请求去重器
 * 防止重复请求被处理多次
 */
class RequestDeduplicator {
  /**
   * @param {number} expirationMs - 请求记录过期时间（毫秒）
   */
  constructor(expirationMs = 30000) {
    this.expirationMs = expirationMs;
    this.processingRequests = new Map(); // requestId -> { timestamp, promise }
    this.urlTabCache = new Map(); // url -> { tabId, timestamp }
  }

  /**
   * 检查请求是否正在处理中
   * @param {string} requestId - 请求 ID
   * @returns {Object} { isDuplicate: boolean, existingPromise?: Promise }
   */
  checkRequest(requestId) {
    if (!requestId) {
      return { isDuplicate: false };
    }

    const existing = this.processingRequests.get(requestId);
    if (existing) {
      const now = Date.now();
      // 检查是否过期
      if (now - existing.timestamp < this.expirationMs) {
        console.log(`[Deduplicator] 请求 ${requestId} 正在处理中，跳过重复请求`);
        return { 
          isDuplicate: true, 
          existingPromise: existing.promise,
          reason: '请求正在处理中'
        };
      }
      // 已过期，移除
      this.processingRequests.delete(requestId);
    }
    
    return { isDuplicate: false };
  }

  /**
   * 标记请求开始处理
   * @param {string} requestId - 请求 ID
   * @param {Promise} promise - 处理 Promise（可选）
   */
  markProcessing(requestId, promise = null) {
    if (!requestId) return;
    
    this.processingRequests.set(requestId, {
      timestamp: Date.now(),
      promise
    });
  }

  /**
   * 标记请求处理完成
   * @param {string} requestId - 请求 ID
   */
  markCompleted(requestId) {
    if (!requestId) return;
    this.processingRequests.delete(requestId);
  }

  /**
   * 检查 URL 是否已有对应的标签页
   * @param {string} url - URL
   * @returns {Object} { hasExisting: boolean, tabId?: number }
   */
  checkUrlTab(url) {
    if (!url) {
      return { hasExisting: false };
    }

    const cached = this.urlTabCache.get(url);
    if (cached) {
      const now = Date.now();
      // 缓存有效期较短，因为标签页状态可能变化
      if (now - cached.timestamp < 5000) {
        return { 
          hasExisting: true, 
          tabId: cached.tabId 
        };
      }
      this.urlTabCache.delete(url);
    }
    
    return { hasExisting: false };
  }

  /**
   * 缓存 URL 对应的标签页
   * @param {string} url - URL
   * @param {number} tabId - 标签页 ID
   */
  cacheUrlTab(url, tabId) {
    if (!url || !tabId) return;
    
    this.urlTabCache.set(url, {
      tabId,
      timestamp: Date.now()
    });
  }

  /**
   * 清理过期记录
   */
  cleanup() {
    const now = Date.now();
    let cleanedRequests = 0;
    let cleanedUrls = 0;
    
    // 清理过期的请求记录
    for (const [requestId, data] of this.processingRequests) {
      if (now - data.timestamp > this.expirationMs) {
        this.processingRequests.delete(requestId);
        cleanedRequests++;
      }
    }
    
    // 清理过期的 URL 缓存（使用更长的过期时间）
    for (const [url, data] of this.urlTabCache) {
      if (now - data.timestamp > 30000) {
        this.urlTabCache.delete(url);
        cleanedUrls++;
      }
    }
    
    if (cleanedRequests > 0 || cleanedUrls > 0) {
      console.log(`[Deduplicator] 清理了 ${cleanedRequests} 个过期请求, ${cleanedUrls} 个 URL 缓存`);
    }
  }

  /**
   * 获取当前状态
   */
  getStatus() {
    return {
      processingCount: this.processingRequests.size,
      urlCacheCount: this.urlTabCache.size
    };
  }

  /**
   * 重置去重器
   */
  reset() {
    this.processingRequests.clear();
    this.urlTabCache.clear();
    console.log('[Deduplicator] 已重置');
  }
}

/**
 * 请求队列管理器
 * 管理待处理请求的数量和生命周期
 */
class RequestQueueManager {
  /**
   * @param {number} maxSize - 最大队列大小
   * @param {number} requestTimeoutMs - 单个请求超时时间（毫秒）
   */
  constructor(maxSize = 100, requestTimeoutMs = 30000) {
    this.maxSize = maxSize;
    this.requestTimeoutMs = requestTimeoutMs;
    this.requests = new Map(); // requestId -> { timestamp, type, tabId }
  }

  /**
   * 尝试添加新请求
   * @param {string} requestId - 请求 ID
   * @param {string} type - 请求类型
   * @param {Object} metadata - 额外元数据
   * @returns {Object} { accepted: boolean, reason?: string }
   */
  add(requestId, type, metadata = {}) {
    // 先清理过期请求
    this.cleanupExpired();
    
    // 检查队列是否已满
    if (this.requests.size >= this.maxSize) {
      console.warn(`[QueueManager] 队列已满 (${this.requests.size}/${this.maxSize})，拒绝新请求`);
      return {
        accepted: false,
        reason: `请求队列已满（${this.maxSize}），请稍后重试`,
        queueSize: this.requests.size
      };
    }
    
    // 添加请求
    this.requests.set(requestId, {
      timestamp: Date.now(),
      type,
      ...metadata
    });
    
    return { 
      accepted: true,
      queueSize: this.requests.size
    };
  }

  /**
   * 移除请求（完成或取消）
   * @param {string} requestId - 请求 ID
   */
  remove(requestId) {
    this.requests.delete(requestId);
  }

  /**
   * 清理过期请求
   * @returns {Array} 被清理的请求 ID 列表
   */
  cleanupExpired() {
    const now = Date.now();
    const expiredIds = [];
    
    for (const [requestId, data] of this.requests) {
      if (now - data.timestamp > this.requestTimeoutMs) {
        expiredIds.push({
          requestId,
          type: data.type,
          age: now - data.timestamp
        });
        this.requests.delete(requestId);
      }
    }
    
    if (expiredIds.length > 0) {
      console.log(`[QueueManager] 清理了 ${expiredIds.length} 个过期请求:`, 
        expiredIds.map(e => `${e.requestId}(${e.type})`).join(', '));
    }
    
    return expiredIds;
  }

  /**
   * 获取队列状态
   */
  getStatus() {
    return {
      size: this.requests.size,
      maxSize: this.maxSize,
      utilization: (this.requests.size / this.maxSize * 100).toFixed(1) + '%',
      requests: Array.from(this.requests.entries()).map(([id, data]) => ({
        requestId: id,
        type: data.type,
        age: Date.now() - data.timestamp
      }))
    };
  }

  /**
   * 检查请求是否存在
   * @param {string} requestId - 请求 ID
   */
  has(requestId) {
    return this.requests.has(requestId);
  }

  /**
   * 重置队列
   */
  reset() {
    this.requests.clear();
    console.log('[QueueManager] 已重置');
  }
}

// 导出工具类和函数
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    withTimeout,
    RateLimiter,
    RequestDeduplicator,
    RequestQueueManager
  };
} else {
  // 浏览器环境，挂载到 window
  window.ExtensionUtils = {
    withTimeout,
    RateLimiter,
    RequestDeduplicator,
    RequestQueueManager
  };
}
