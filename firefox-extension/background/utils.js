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
 * 
 * 注意：去重窗口已与服务端 v2.0 对齐，默认为 5 秒
 */
class RequestDeduplicator {
  /**
   * @param {number} expirationMs - 请求记录过期时间（毫秒），默认 5000ms（与服务端对齐）
   */
  constructor(expirationMs = 5000) {
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

/**
 * 服务健康检查器
 * 定期检查服务端健康状态，实现熔断保护
 */
class HealthChecker {
  /**
   * @param {Object} config - 配置对象
   * @param {string} config.httpServerUrl - HTTP 服务器地址
   * @param {string} config.endpoint - 健康检查端点
   * @param {number} config.interval - 检查间隔（毫秒）
   * @param {number} config.criticalCooldown - critical 状态冷却期（毫秒）
   * @param {number} config.warningThrottle - warning 状态降速比例 (0-1)
   * @param {number} config.timeout - 请求超时时间（毫秒）
   */
  constructor(config = {}) {
    this.httpServerUrl = config.httpServerUrl || '';
    this.endpoint = config.endpoint || '/api/browser/health';
    this.interval = config.interval || 30000;
    this.criticalCooldown = config.criticalCooldown || 60000;
    this.warningThrottle = config.warningThrottle || 0.5;
    this.timeout = config.timeout || 5000;
    
    // 状态
    this.currentStatus = 'unknown'; // unknown, healthy, warning, critical
    this.lastCheck = null;
    this.lastHealthData = null;
    this.circuitBreakerUntil = 0; // 熔断恢复时间
    this.checkTimer = null;
    this.consecutiveFailures = 0;
    this.maxConsecutiveFailures = 3;
    
    // 回调
    this.onStatusChange = null;
  }

  /**
   * 启动健康检查
   */
  start() {
    if (this.checkTimer) {
      return;
    }
    
    console.log('[HealthChecker] 启动健康检查，间隔:', this.interval, 'ms');
    
    // 立即执行一次检查
    this.check();
    
    // 设置定时检查
    this.checkTimer = setInterval(() => {
      this.check();
    }, this.interval);
  }

  /**
   * 停止健康检查
   */
  stop() {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
      console.log('[HealthChecker] 已停止健康检查');
    }
  }

  /**
   * 执行健康检查
   * @returns {Promise<Object>} 健康状态数据
   */
  async check() {
    const url = `${this.httpServerUrl}${this.endpoint}`;
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);
      
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      // 503 是完整版服务器在 critical 状态时返回的有效状态码
      if (!response.ok && response.status !== 503) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const data = await response.json();
      this.consecutiveFailures = 0;
      this.lastCheck = Date.now();
      this.lastHealthData = data;
      
      const previousStatus = this.currentStatus;
      // 宽容解析：支持 { status: 'healthy' }, { ok: true }, 及无 status 字段
      if (data.status) {
        this.currentStatus = data.status;
      } else if (data.ok !== undefined) {
        this.currentStatus = data.ok ? 'healthy' : 'critical';
      } else {
        this.currentStatus = response.status === 200 ? 'healthy' : 'critical';
      }
      
      // 根据状态处理熔断
      if (this.currentStatus === 'critical') {
        this.circuitBreakerUntil = Date.now() + this.criticalCooldown;
        console.warn('[HealthChecker] 服务状态 critical，进入熔断状态');
      } else if (this.currentStatus === 'healthy') {
        this.circuitBreakerUntil = 0;
      }
      
      // 触发状态变化回调
      if (previousStatus !== this.currentStatus && this.onStatusChange) {
        this.onStatusChange(this.currentStatus, previousStatus, data);
      }
      
      console.log(`[HealthChecker] 健康检查完成: ${this.currentStatus}`, data);
      return data;
      
    } catch (error) {
      this.consecutiveFailures++;
      this.lastCheck = Date.now();
      
      console.error(`[HealthChecker] 健康检查失败 (${this.consecutiveFailures}/${this.maxConsecutiveFailures}):`, error.message);
      
      // 连续失败超过阈值，进入熔断
      if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
        const previousStatus = this.currentStatus;
        this.currentStatus = 'critical';
        this.circuitBreakerUntil = Date.now() + this.criticalCooldown;
        
        if (previousStatus !== 'critical' && this.onStatusChange) {
          this.onStatusChange('critical', previousStatus, { error: error.message });
        }
      }
      
      return { status: 'error', error: error.message };
    }
  }

  /**
   * 检查是否允许发送请求（熔断检查）
   * @returns {Object} { allowed: boolean, reason?: string, throttle?: number }
   */
  canSendRequest() {
    const now = Date.now();
    
    // 检查熔断状态
    if (now < this.circuitBreakerUntil) {
      const retryAfter = Math.ceil((this.circuitBreakerUntil - now) / 1000);
      return {
        allowed: false,
        reason: `服务熔断中，请在 ${retryAfter} 秒后重试`,
        retryAfter
      };
    }
    
    // warning 状态返回降速建议
    if (this.currentStatus === 'warning') {
      return {
        allowed: true,
        throttle: this.warningThrottle,
        reason: '服务负载较高，建议降低请求频率'
      };
    }
    
    return { allowed: true };
  }

  /**
   * 获取当前状态
   * @returns {Object} 状态信息
   */
  getStatus() {
    const now = Date.now();
    return {
      status: this.currentStatus,
      lastCheck: this.lastCheck,
      lastCheckAgo: this.lastCheck ? now - this.lastCheck : null,
      isCircuitBreakerOpen: now < this.circuitBreakerUntil,
      circuitBreakerUntil: this.circuitBreakerUntil > now ? this.circuitBreakerUntil : null,
      consecutiveFailures: this.consecutiveFailures,
      healthData: this.lastHealthData
    };
  }

  /**
   * 手动重置熔断状态
   */
  resetCircuitBreaker() {
    this.circuitBreakerUntil = 0;
    this.consecutiveFailures = 0;
    console.log('[HealthChecker] 熔断状态已重置');
  }

  /**
   * 更新配置
   * @param {Object} config - 新配置
   */
  updateConfig(config) {
    if (config.httpServerUrl) this.httpServerUrl = config.httpServerUrl;
    if (config.endpoint) this.endpoint = config.endpoint;
    if (config.interval) {
      this.interval = config.interval;
      // 如果正在运行，重启以应用新间隔
      if (this.checkTimer) {
        this.stop();
        this.start();
      }
    }
    if (config.criticalCooldown) this.criticalCooldown = config.criticalCooldown;
    if (config.warningThrottle) this.warningThrottle = config.warningThrottle;
    if (config.timeout) this.timeout = config.timeout;
    
    console.log('[HealthChecker] 配置已更新');
  }
}

/**
 * SSE 客户端
 * 用于接收服务端推送事件，作为 WebSocket 的降级方案
 */
class SSEClient {
  /**
   * @param {Object} config - 配置对象
   * @param {string} config.httpServerUrl - HTTP 服务器地址
   * @param {string} config.endpoint - SSE 端点
   * @param {number} config.reconnectInterval - 重连间隔（毫秒）
   * @param {number} config.maxReconnectAttempts - 最大重连次数
   */
  constructor(config = {}) {
    this.httpServerUrl = config.httpServerUrl || '';
    this.endpoint = config.endpoint || '/api/browser/events';
    this.reconnectInterval = config.reconnectInterval || 5000;
    this.maxReconnectAttempts = config.maxReconnectAttempts || 10;
    
    this.eventSource = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.currentRequestId = null;
    
    // 事件回调
    this.onMessage = null;
    this.onCallbackResult = null;
    this.onRequestTimeout = null;
    this.onError = null;
    this.onConnect = null;
    this.onDisconnect = null;
  }

  /**
   * 连接到 SSE 端点
   * @param {string} requestId - 可选，订阅特定请求的事件
   */
  connect(requestId = null) {
    if (this.eventSource) {
      this.disconnect();
    }
    
    this.currentRequestId = requestId;
    let url = `${this.httpServerUrl}${this.endpoint}`;
    if (requestId) {
      url += `?requestId=${encodeURIComponent(requestId)}`;
    }
    
    console.log('[SSEClient] 连接到:', url);
    
    try {
      this.eventSource = new EventSource(url);
      
      this.eventSource.onopen = () => {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        console.log('[SSEClient] 连接已建立');
        if (this.onConnect) {
          this.onConnect();
        }
      };
      
      this.eventSource.onerror = (error) => {
        console.error('[SSEClient] 连接错误:', error);
        this.isConnected = false;
        
        if (this.onError) {
          this.onError(error);
        }
        
        // 尝试重连
        this.scheduleReconnect();
      };
      
      // 监听通用消息
      this.eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log('[SSEClient] 收到消息:', data);
          if (this.onMessage) {
            this.onMessage(data);
          }
        } catch (e) {
          console.error('[SSEClient] 解析消息失败:', e);
        }
      };
      
      // 监听回调结果事件
      this.eventSource.addEventListener('callback_result', (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log('[SSEClient] 收到回调结果:', data);
          if (this.onCallbackResult) {
            this.onCallbackResult(data);
          }
        } catch (e) {
          console.error('[SSEClient] 解析回调结果失败:', e);
        }
      });
      
      // 监听请求超时事件
      this.eventSource.addEventListener('request_timeout', (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log('[SSEClient] 收到超时通知:', data);
          if (this.onRequestTimeout) {
            this.onRequestTimeout(data);
          }
        } catch (e) {
          console.error('[SSEClient] 解析超时通知失败:', e);
        }
      });
      
    } catch (error) {
      console.error('[SSEClient] 创建连接失败:', error);
      this.scheduleReconnect();
    }
  }

  /**
   * 断开连接
   */
  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    
    this.isConnected = false;
    this.currentRequestId = null;
    
    console.log('[SSEClient] 已断开连接');
    if (this.onDisconnect) {
      this.onDisconnect();
    }
  }

  /**
   * 安排重连
   */
  scheduleReconnect() {
    if (this.reconnectTimer) {
      return;
    }
    
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[SSEClient] 达到最大重连次数，停止重连');
      return;
    }
    
    this.reconnectAttempts++;
    const delay = this.reconnectInterval * Math.pow(1.5, this.reconnectAttempts - 1);
    
    console.log(`[SSEClient] 将在 ${delay}ms 后重连 (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(this.currentRequestId);
    }, delay);
  }

  /**
   * 获取连接状态
   */
  getStatus() {
    return {
      isConnected: this.isConnected,
      reconnectAttempts: this.reconnectAttempts,
      currentRequestId: this.currentRequestId
    };
  }
}

// 导出工具类和函数
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    withTimeout,
    RateLimiter,
    RequestDeduplicator,
    RequestQueueManager,
    HealthChecker,
    SSEClient
  };
} else {
  // 浏览器环境，挂载到 window
  window.ExtensionUtils = {
    withTimeout,
    RateLimiter,
    RequestDeduplicator,
    RequestQueueManager,
    HealthChecker,
    SSEClient
  };
}
