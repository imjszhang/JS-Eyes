/**
 * Browser Control Extension - Background Script
 * 
 * 负责与browserControlServer的WebSocket通信
 * 处理标签页管理、内容获取、脚本执行等功能
 * 
 * 安全特性：
 * - 实现扩展中转通信模式
 * - 验证来自 Content Script 的请求
 * - 敏感操作权限验证
 */

class BrowserControl {
  constructor() {
    this.ws = null;
    this.isConnected = false;
    
    // 默认WebSocket服务器地址列表
    this.defaultServerUrls = (typeof EXTENSION_CONFIG !== 'undefined' && EXTENSION_CONFIG.WEBSOCKET_SERVER_URLS) 
      ? EXTENSION_CONFIG.WEBSOCKET_SERVER_URLS 
      : ['ws://localhost:8080', 'ws://example.local:8080'];
    
    this.serverUrls = [...this.defaultServerUrls];
    this.currentServerIndex = 0;
    this.serverUrl = null; // 将在loadSettings中设置
    
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 2000;
    this.pendingRequests = new Map();
    
    // 自动连接相关
    this.autoConnect = true; // 默认启用自动连接
    this.reconnectTimer = null; // 重连定时器
    this.isReconnecting = false; // 是否正在重连
    
    // 安全配置
    this.securityConfig = (typeof EXTENSION_CONFIG !== 'undefined' && EXTENSION_CONFIG.SECURITY) 
      ? EXTENSION_CONFIG.SECURITY 
      : {
          allowedActions: [
            'get_tabs', 'get_html', 'open_url', 'close_tab',
            'execute_script', 'get_cookies', 'get_cookies_by_domain', 'inject_css',
            'get_page_info', 'upload_file_to_tab'
          ],
          sensitiveActions: ['execute_script', 'get_cookies', 'get_cookies_by_domain'],
          requestTimeout: 30000,
          rateLimit: {
            maxRequestsPerSecond: 10,
            blockDuration: 5000
          },
          auth: {
            storageKey: 'auth_secret_key',
            authTimeout: 10000,
            sessionRefreshBefore: 300
          }
        };
    
    // 认证相关属性
    this.sessionId = null;           // 会话ID
    this.authState = 'disconnected'; // disconnected | authenticating | authenticated | failed
    this.pendingChallenge = null;    // 等待响应的 challenge
    this.authSecretKey = null;       // 认证密钥（从 storage 加载）
    this.sessionExpiresAt = null;    // 会话过期时间
    this.authTimeout = null;         // 认证超时定时器
    
    // 稳定性相关工具（从 utils.js 加载）
    this.initStabilityTools();
    
    // 初始化
    this.init();
  }

  /**
   * 初始化稳定性相关工具
   * 包括速率限制器、请求去重器、请求队列管理器
   */
  initStabilityTools() {
    // 获取工具类（从 window.ExtensionUtils）
    const Utils = typeof ExtensionUtils !== 'undefined' ? ExtensionUtils : null;
    
    if (Utils) {
      // 速率限制器
      const rateLimitConfig = this.securityConfig.rateLimit || {};
      this.rateLimiter = new Utils.RateLimiter(
        rateLimitConfig.maxRequestsPerSecond || 10,
        1000,
        rateLimitConfig.blockDuration || 5000
      );
      
      // 请求去重器
      const requestTimeout = this.securityConfig.requestTimeout || 30000;
      this.deduplicator = new Utils.RequestDeduplicator(requestTimeout);
      
      // 请求队列管理器
      this.queueManager = new Utils.RequestQueueManager(100, requestTimeout);
      
      // 超时包装器函数
      this.withTimeout = Utils.withTimeout;
      
      // 健康检查器
      this.initHealthChecker(Utils);
      
      // SSE 客户端（作为 WebSocket 降级方案）
      this.initSSEClient(Utils);
      
      console.log('[BrowserControl] 稳定性工具已初始化');
    } else {
      console.warn('[BrowserControl] ExtensionUtils 未加载，使用降级模式');
      
      // 降级模式：提供基本功能
      this.rateLimiter = null;
      this.deduplicator = null;
      this.queueManager = null;
      this.healthChecker = null;
      this.sseClient = null;
      this.withTimeout = async (promise, ms, errorMessage) => {
        // 简单的超时实现
        let timeoutId;
        const timeoutPromise = new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error(errorMessage || '操作超时')), ms);
        });
        try {
          return await Promise.race([promise, timeoutPromise]);
        } finally {
          clearTimeout(timeoutId);
        }
      };
    }
    
    // 启动定期清理任务
    this.startCleanupTask();
  }
  
  /**
   * 初始化健康检查器
   * @param {Object} Utils - 工具类对象
   */
  initHealthChecker(Utils) {
    if (!Utils || !Utils.HealthChecker) {
      console.warn('[BrowserControl] HealthChecker 类不可用');
      this.healthChecker = null;
      return;
    }
    
    // 获取健康检查配置
    const healthConfig = (typeof EXTENSION_CONFIG !== 'undefined' && EXTENSION_CONFIG.HEALTH_CHECK)
      ? EXTENSION_CONFIG.HEALTH_CHECK
      : { enabled: true, interval: 30000, endpoint: '/api/browser/health' };
    
    if (!healthConfig.enabled) {
      console.log('[BrowserControl] 健康检查已禁用');
      this.healthChecker = null;
      return;
    }
    
    // 获取 HTTP 服务器地址
    const httpServerUrl = (typeof EXTENSION_CONFIG !== 'undefined' && EXTENSION_CONFIG.HTTP_SERVER_URL)
      ? EXTENSION_CONFIG.HTTP_SERVER_URL
      : 'http://localhost:3333';
    
    // 创建健康检查器实例
    this.healthChecker = new Utils.HealthChecker({
      httpServerUrl: httpServerUrl,
      endpoint: healthConfig.endpoint || '/api/browser/health',
      interval: healthConfig.interval || 30000,
      timeout: healthConfig.timeout || 5000,
      criticalCooldown: healthConfig.circuitBreaker?.criticalCooldown || 60000,
      warningThrottle: healthConfig.circuitBreaker?.warningThrottle || 0.5
    });
    
    // 设置状态变化回调
    this.healthChecker.onStatusChange = (newStatus, oldStatus, data) => {
      console.log(`[HealthChecker] 服务状态变化: ${oldStatus} -> ${newStatus}`, data);
      
      // 通知 Popup 状态变化
      this.broadcastStatusUpdate();
      
      // 如果状态恢复为 healthy，尝试重新连接 WebSocket
      if (newStatus === 'healthy' && oldStatus === 'critical' && !this.isConnected) {
        console.log('[HealthChecker] 服务恢复，尝试重新连接 WebSocket');
        this.connect();
      }
    };
    
    console.log('[BrowserControl] 健康检查器已初始化');
  }
  
  /**
   * 初始化 SSE 客户端
   * @param {Object} Utils - 工具类对象
   */
  initSSEClient(Utils) {
    if (!Utils || !Utils.SSEClient) {
      console.warn('[BrowserControl] SSEClient 类不可用');
      this.sseClient = null;
      return;
    }
    
    // 获取 SSE 配置
    const sseConfig = (typeof EXTENSION_CONFIG !== 'undefined' && EXTENSION_CONFIG.SSE)
      ? EXTENSION_CONFIG.SSE
      : { enabled: true, endpoint: '/api/browser/events' };
    
    if (!sseConfig.enabled) {
      console.log('[BrowserControl] SSE 已禁用');
      this.sseClient = null;
      return;
    }
    
    // 获取 HTTP 服务器地址
    const httpServerUrl = (typeof EXTENSION_CONFIG !== 'undefined' && EXTENSION_CONFIG.HTTP_SERVER_URL)
      ? EXTENSION_CONFIG.HTTP_SERVER_URL
      : 'http://localhost:3333';
    
    // WebSocket 失败多少次后降级到 SSE
    this.sseFallbackThreshold = sseConfig.fallbackAfterWsFailures || 5;
    this.wsConsecutiveFailures = 0;
    this.connectionMode = 'websocket'; // websocket | sse
    
    // 创建 SSE 客户端实例
    this.sseClient = new Utils.SSEClient({
      httpServerUrl: httpServerUrl,
      endpoint: sseConfig.endpoint || '/api/browser/events',
      reconnectInterval: sseConfig.reconnectInterval || 5000,
      maxReconnectAttempts: sseConfig.maxReconnectAttempts || 10
    });
    
    // 设置回调
    this.sseClient.onCallbackResult = (data) => {
      // 处理通过 SSE 接收到的回调结果
      this.handleServerResponse({
        type: 'callback_result',
        requestId: data.requestId,
        status: 'completed',
        data: data.result
      });
    };
    
    this.sseClient.onRequestTimeout = (data) => {
      // 处理请求超时通知
      this.handleServerResponse({
        type: 'request_timeout',
        requestId: data.requestId,
        status: 'timeout',
        error: '服务端请求超时'
      });
    };
    
    this.sseClient.onConnect = () => {
      console.log('[BrowserControl] SSE 连接成功（降级模式）');
      this.broadcastStatusUpdate();
    };
    
    this.sseClient.onDisconnect = () => {
      console.log('[BrowserControl] SSE 连接断开');
      this.broadcastStatusUpdate();
    };
    
    console.log('[BrowserControl] SSE 客户端已初始化');
  }
  
  /**
   * 广播状态更新到 Popup
   */
  broadcastStatusUpdate() {
    try {
      browser.runtime.sendMessage({
        type: 'STATUS_UPDATE',
        data: this.getExtendedStatus()
      }).catch(() => {
        // Popup 可能未打开，忽略错误
      });
    } catch (e) {
      // 忽略
    }
  }
  
  /**
   * 获取扩展状态（包含健康检查等新信息）
   */
  getExtendedStatus() {
    return {
      // 连接状态
      isConnected: this.isConnected,
      connectionMode: this.connectionMode || 'websocket',
      serverUrl: this.serverUrl,
      authState: this.authState,
      
      // 健康检查状态
      healthCheck: this.healthChecker ? this.healthChecker.getStatus() : null,
      
      // SSE 状态
      sseStatus: this.sseClient ? this.sseClient.getStatus() : null,
      
      // 队列状态
      queueStatus: this.queueManager ? this.queueManager.getStatus() : null,
      
      // 限流状态
      rateLimitStatus: this.rateLimiter ? this.rateLimiter.getStatus() : null
    };
  }
  
  /**
   * 检查是否可以发送请求（综合熔断和限流检查）
   * @returns {Object} { allowed: boolean, reason?: string }
   */
  canSendRequest() {
    // 健康检查熔断
    if (this.healthChecker) {
      const healthCheck = this.healthChecker.canSendRequest();
      if (!healthCheck.allowed) {
        return healthCheck;
      }
    }
    
    // 本地限流检查
    if (this.rateLimiter) {
      const rateCheck = this.rateLimiter.check();
      if (!rateCheck.allowed) {
        return rateCheck;
      }
    }
    
    return { allowed: true };
  }

  /**
   * 启动定期清理任务
   * 每 10 秒清理过期请求和缓存
   */
  startCleanupTask() {
    setInterval(() => {
      try {
        if (this.deduplicator) {
          this.deduplicator.cleanup();
        }
        if (this.queueManager) {
          const expiredRequests = this.queueManager.cleanupExpired();
          // 为过期的请求发送超时响应
          for (const expired of expiredRequests) {
            this.sendMessage({
              type: 'error',
              message: `请求超时: ${expired.type}`,
              requestId: expired.requestId,
              code: 'TIMEOUT'
            });
          }
        }
      } catch (error) {
        console.error('[CleanupTask] 清理任务出错:', error);
      }
    }, 10000); // 每 10 秒执行一次
  }

  /**
   * 初始化扩展
   */
  async init() {
    console.log('Browser Control Extension 正在初始化...');
    
    // 加载用户设置
    await this.loadSettings();
    
    // 设置标签页事件监听
    this.setupTabListeners();
    
    // 设置消息监听
    this.setupMessageListeners();
    
    // 定期发送标签页数据（仅在连接时发送）
    this.startTabDataSync();
    
    // 如果启用自动连接，则自动连接
    if (this.autoConnect) {
      console.log('自动连接已启用，正在连接...');
      this.connect();
    } else {
      console.log('扩展初始化完成 - 等待手动连接');
    }
  }

  /**
   * 加载用户设置
   */
  async loadSettings() {
    try {
      const authStorageKey = this.securityConfig.auth?.storageKey || 'auth_secret_key';
      const result = await browser.storage.local.get(['serverUrl', 'autoConnect', authStorageKey]);
      
      if (result.serverUrl) {
        // 使用用户设置的服务器地址
        this.serverUrl = result.serverUrl;
        console.log('已加载用户设置的服务器地址:', this.serverUrl);
      } else {
        // 使用默认服务器地址
        this.serverUrl = this.defaultServerUrls[0];
        console.log('使用默认服务器地址:', this.serverUrl);
      }
      
      // 加载自动连接设置（默认启用）
      if (result.autoConnect !== undefined) {
        this.autoConnect = result.autoConnect;
        console.log('自动连接设置:', this.autoConnect ? '启用' : '禁用');
      } else {
        this.autoConnect = true; // 默认启用
        console.log('使用默认自动连接设置: 启用');
      }
      
      // 加载认证密钥
      if (result[authStorageKey]) {
        this.authSecretKey = result[authStorageKey];
        console.log('已加载认证密钥');
      } else {
        this.authSecretKey = null;
        console.log('未配置认证密钥');
      }
      
    } catch (error) {
      console.error('加载设置时出错:', error);
      // 使用默认设置
      this.serverUrl = this.defaultServerUrls[0];
      this.autoConnect = true;
      this.authSecretKey = null;
    }
  }

  /**
   * 保存认证密钥
   * @param {string} authKey - 认证密钥
   */
  async saveAuthKey(authKey) {
    try {
      const authStorageKey = this.securityConfig.auth?.storageKey || 'auth_secret_key';
      await browser.storage.local.set({ [authStorageKey]: authKey });
      this.authSecretKey = authKey;
      console.log('认证密钥已保存');
      
      // 如果当前已连接但未认证，尝试重新连接以进行认证
      if (this.isConnected && this.authState !== 'authenticated') {
        console.log('检测到新密钥，正在重新连接...');
        this.reconnectWithNewSettings();
      }
    } catch (error) {
      console.error('保存认证密钥失败:', error);
      throw error;
    }
  }

  /**
   * 清除认证密钥
   */
  async clearAuthKey() {
    try {
      const authStorageKey = this.securityConfig.auth?.storageKey || 'auth_secret_key';
      await browser.storage.local.remove(authStorageKey);
      this.authSecretKey = null;
      this.sessionId = null;
      this.authState = 'disconnected';
      console.log('认证密钥已清除');
    } catch (error) {
      console.error('清除认证密钥失败:', error);
      throw error;
    }
  }

  /**
   * 计算 HMAC-SHA256
   * 使用 Web Crypto API 实现
   * 
   * @param {string} secretKey - 密钥
   * @param {string} message - 要签名的消息
   * @returns {Promise<string>} - 64位十六进制字符串（小写）
   */
  async computeHMAC(secretKey, message) {
    try {
      const encoder = new TextEncoder();
      const keyData = encoder.encode(secretKey);
      
      // 导入密钥
      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        keyData,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      
      // 计算 HMAC
      const messageData = encoder.encode(message);
      const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
      
      // 转为十六进制字符串
      const hashArray = Array.from(new Uint8Array(signature));
      const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      
      return hashHex;
    } catch (error) {
      console.error('计算 HMAC 失败:', error);
      throw error;
    }
  }

  /**
   * 连接到WebSocket服务器
   */
  connect() {
    try {
      console.log(`正在连接到 ${this.serverUrl}...`);
      
      // 重置认证状态
      this.authState = 'disconnected';
      this.sessionId = null;
      this.pendingChallenge = null;
      this.sessionExpiresAt = null;
      
      // 清除认证超时
      if (this.authTimeout) {
        clearTimeout(this.authTimeout);
        this.authTimeout = null;
      }
      
      this.ws = new WebSocket(this.serverUrl);
      
      this.ws.onopen = () => {
        console.log('WebSocket连接已建立，等待服务器认证挑战...');
        this.isConnected = true;
        this.isReconnecting = false;
        this.authState = 'authenticating';
        this.connectionMode = 'websocket';
        
        // 重置重连计数器
        this.resetReconnectCounter();
        
        // 清除重连定时器
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        
        // 启动健康检查
        if (this.healthChecker) {
          this.healthChecker.start();
        }
        
        // 如果之前使用 SSE 降级模式，断开 SSE
        if (this.sseClient && this.sseClient.isConnected) {
          console.log('[BrowserControl] WebSocket 恢复，断开 SSE 降级连接');
          this.sseClient.disconnect();
        }
        
        // 广播状态更新
        this.broadcastStatusUpdate();
        
        // 设置认证超时（如果服务器不发送 challenge，可能是旧版服务器）
        const authTimeout = this.securityConfig.auth?.authTimeout || 10000;
        this.authTimeout = setTimeout(() => {
          if (this.authState === 'authenticating' && !this.pendingChallenge) {
            // 服务器没有发送 challenge，按旧版逻辑处理（向后兼容）
            console.log('服务器未发送认证挑战，按旧版协议处理');
            this.authState = 'authenticated';
            this.sessionId = null; // 旧版协议无 sessionId
            
            // 发送初始化消息（旧版协议）
            this.sendRawMessage({
              type: 'init',
              timestamp: new Date().toISOString(),
              userAgent: navigator.userAgent
            });
            
            // 立即发送一次标签页数据
            this.sendTabsData();
          }
        }, authTimeout);
      };
      
      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };
      
      this.ws.onclose = (event) => {
        console.log('WebSocket连接已关闭:', event.code, event.reason);
        this.isConnected = false;
        
        // 清除认证超时
        if (this.authTimeout) {
          clearTimeout(this.authTimeout);
          this.authTimeout = null;
        }
        
        // 如果是认证失败导致的关闭（4001-4004 是自定义认证错误码），不自动重连
        const isAuthError = event.code >= 4001 && event.code <= 4010;
        if (isAuthError || this.authState === 'failed') {
          console.log('认证失败，不自动重连。错误码:', event.code, event.reason);
          this.authState = 'failed';
          this.sessionId = null;
          return;
        }
        
        // 重置认证状态
        this.authState = 'disconnected';
        this.sessionId = null;
        
        // 如果启用自动连接，则尝试重连
        if (this.autoConnect && !this.isReconnecting) {
          this.attemptReconnect();
        }
      };
      
      this.ws.onerror = (error) => {
        console.error('WebSocket错误:', error);
        this.isConnected = false;
        this.wsConsecutiveFailures = (this.wsConsecutiveFailures || 0) + 1;
        
        console.log(`[WebSocket] 连续失败次数: ${this.wsConsecutiveFailures}/${this.sseFallbackThreshold || 5}`);
        
        // 检查是否需要降级到 SSE
        if (this.shouldFallbackToSSE()) {
          this.fallbackToSSE();
          return;
        }
        
        // 如果启用自动连接，则尝试重连
        if (this.autoConnect && !this.isReconnecting) {
          this.attemptReconnect();
        }
      };
      
    } catch (error) {
      console.error('连接WebSocket时出错:', error);
      this.isConnected = false;
      
      // 如果启用自动连接，则尝试重连
      if (this.autoConnect && !this.isReconnecting) {
        this.attemptReconnect();
      }
    }
  }

  /**
   * 处理服务器认证挑战
   * @param {Object} message - 认证挑战消息
   */
  async handleAuthChallenge(message) {
    try {
      const { challenge, timestamp, serverVersion } = message;
      
      console.log('收到服务器认证挑战:', { 
        challengeLength: challenge?.length,
        serverVersion,
        timestamp 
      });
      
      // 清除认证超时（收到 challenge 说明是新版服务器）
      if (this.authTimeout) {
        clearTimeout(this.authTimeout);
        this.authTimeout = null;
      }
      
      // 检查是否配置了密钥
      if (!this.authSecretKey) {
        console.error('未配置认证密钥，无法完成认证');
        this.authState = 'failed';
        // 关闭连接
        if (this.ws) {
          this.ws.close(4001, '未配置认证密钥');
        }
        return;
      }
      
      // 保存 challenge 用于验证
      this.pendingChallenge = challenge;
      
      // 计算 HMAC 响应
      const response = await this.computeHMAC(this.authSecretKey, challenge);
      
      // 发送认证响应
      this.sendRawMessage({
        type: 'auth_response',
        clientId: browser.runtime.id,
        clientType: 'extension',
        response: response,
        timestamp: new Date().toISOString()
      });
      
      console.log('已发送认证响应');
      
      // 设置认证结果超时
      const authResultTimeout = this.securityConfig.auth?.authTimeout || 10000;
      this.authTimeout = setTimeout(() => {
        if (this.authState === 'authenticating') {
          console.error('等待认证结果超时');
          this.authState = 'failed';
          if (this.ws) {
            this.ws.close(4002, '认证超时');
          }
        }
      }, authResultTimeout);
      
    } catch (error) {
      console.error('处理认证挑战时出错:', error);
      this.authState = 'failed';
      if (this.ws) {
        this.ws.close(4003, '认证处理错误');
      }
    }
  }

  /**
   * 处理服务器认证结果
   * @param {Object} message - 认证结果消息
   */
  handleAuthResult(message) {
    // 清除认证超时
    if (this.authTimeout) {
      clearTimeout(this.authTimeout);
      this.authTimeout = null;
    }
    
    if (message.success) {
      console.log('认证成功!', {
        sessionId: message.sessionId,
        expiresIn: message.expiresIn,
        permissions: message.permissions
      });
      
      this.authState = 'authenticated';
      this.sessionId = message.sessionId;
      
      // 计算会话过期时间
      if (message.expiresIn) {
        this.sessionExpiresAt = Date.now() + (message.expiresIn * 1000);
        
        // 设置会话刷新定时器（在过期前刷新）
        const refreshBefore = (this.securityConfig.auth?.sessionRefreshBefore || 300) * 1000;
        const refreshDelay = Math.max((message.expiresIn * 1000) - refreshBefore, 60000);
        setTimeout(() => {
          this.refreshSession();
        }, refreshDelay);
      }
      
      // 发送初始化消息（使用新版协议）
      this.sendMessage({
        type: 'init',
        timestamp: new Date().toISOString(),
        userAgent: navigator.userAgent
      });
      
      // 立即发送一次标签页数据
      this.sendTabsData();
      
      // 从服务端同步配置
      this.syncServerConfig();
      
    } else {
      console.error('认证失败:', message.error);
      this.authState = 'failed';
      this.sessionId = null;
      
      // 记录重试时间
      if (message.retryAfter) {
        console.log(`服务器建议 ${message.retryAfter} 秒后重试`);
      }
      
      // 关闭连接
      if (this.ws) {
        this.ws.close(4004, '认证失败');
      }
    }
  }

  /**
   * 从服务端同步配置
   * 获取服务端的超时、限流等配置，更新本地设置
   */
  async syncServerConfig() {
    try {
      // 获取 HTTP 服务器地址
      const httpServerUrl = (typeof EXTENSION_CONFIG !== 'undefined' && EXTENSION_CONFIG.HTTP_SERVER_URL)
        ? EXTENSION_CONFIG.HTTP_SERVER_URL
        : 'http://localhost:3333';
      
      const configUrl = `${httpServerUrl}/api/browser/config`;
      
      console.log('[ConfigSync] 正在从服务端获取配置...');
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(configUrl, {
        method: 'GET',
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        // 服务端可能不支持配置端点（旧版本），使用默认配置
        console.log('[ConfigSync] 服务端未返回配置（可能是旧版本），使用默认配置');
        return;
      }
      
      const serverConfig = await response.json();
      console.log('[ConfigSync] 获取到服务端配置:', serverConfig);
      
      // 应用服务端配置
      this.applyServerConfig(serverConfig);
      
    } catch (error) {
      // 配置同步失败不影响正常功能
      console.warn('[ConfigSync] 配置同步失败（使用默认配置）:', error.message);
    }
  }
  
  /**
   * 应用服务端配置到本地
   * @param {Object} serverConfig - 服务端配置
   */
  applyServerConfig(serverConfig) {
    // 同步超时配置
    if (serverConfig.request?.defaultTimeout) {
      const newTimeout = serverConfig.request.defaultTimeout;
      this.securityConfig.requestTimeout = newTimeout;
      
      // 更新队列管理器的超时设置
      if (this.queueManager) {
        this.queueManager.requestTimeoutMs = newTimeout;
      }
      
      // 更新去重器的过期时间
      if (this.deduplicator) {
        this.deduplicator.expirationMs = newTimeout;
      }
      
      console.log(`[ConfigSync] 请求超时已更新: ${newTimeout}ms`);
    }
    
    // 同步限流配置
    if (serverConfig.rateLimit) {
      const rateConfig = serverConfig.rateLimit;
      
      // 更新本地限流器
      if (this.rateLimiter && rateConfig.callbackQueryLimit) {
        // 转换为每秒限制（服务端是每分钟）
        const perSecond = Math.ceil(rateConfig.callbackQueryLimit / 60);
        this.rateLimiter.maxRequests = perSecond;
        console.log(`[ConfigSync] 限流已更新: ${perSecond} 次/秒`);
      }
    }
    
    // 同步资源监控阈值
    if (serverConfig.resourceMonitor && this.healthChecker) {
      const monitorConfig = serverConfig.resourceMonitor;
      
      if (monitorConfig.warningThreshold) {
        this.healthChecker.warningThrottle = monitorConfig.warningThreshold;
      }
      
      console.log('[ConfigSync] 资源监控配置已更新');
    }
    
    // 保存同步的配置供参考
    this.serverConfig = serverConfig;
    
    console.log('[ConfigSync] 服务端配置同步完成');
    
    // 广播状态更新
    this.broadcastStatusUpdate();
  }

  /**
   * 刷新会话（重新认证）
   */
  async refreshSession() {
    if (this.authState !== 'authenticated' || !this.isConnected) {
      return;
    }
    
    console.log('会话即将过期，正在刷新...');
    
    // 重新连接以刷新会话
    this.reconnectWithNewSettings();
  }


  /**
   * 发送原始消息到服务器（不添加 sessionId，用于认证流程）
   */
  sendRawMessage(message) {
    if (this.isConnected && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return true;
    } else {
      console.warn('WebSocket未连接，无法发送消息:', message);
      return false;
    }
  }

  /**
   * 发送消息到服务器
   * 如果已认证，自动添加 sessionId
   */
  sendMessage(message) {
    if (this.isConnected && this.ws.readyState === WebSocket.OPEN) {
      // 如果已认证且有 sessionId，使用新协议格式
      if (this.authState === 'authenticated' && this.sessionId) {
        // 新协议格式：将原消息包装为 request
        const wrappedMessage = {
          type: 'request',
          sessionId: this.sessionId,
          requestId: message.requestId || this.generateRequestId(),
          action: message.type,
          payload: { ...message },
          timestamp: message.timestamp || new Date().toISOString()
        };
        // 移除 payload 中的冗余字段
        delete wrappedMessage.payload.type;
        delete wrappedMessage.payload.timestamp;
        delete wrappedMessage.payload.requestId;
        
        this.ws.send(JSON.stringify(wrappedMessage));
      } else {
        // 旧协议格式或未认证时直接发送
        this.ws.send(JSON.stringify(message));
      }
      return true;
    } else {
      console.warn('WebSocket未连接，无法发送消息:', message);
      return false;
    }
  }

  /**
   * 生成唯一请求ID
   */
  generateRequestId() {
    return `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * 处理来自服务器的消息
   * 包含速率限制、请求去重、队列管理
   */
  async handleMessage(data) {
    try {
      const message = JSON.parse(data);
      console.log('收到服务器消息:', message.type, message);
      
      // 优先处理认证相关消息（不受限制）
      switch (message.type) {
        case 'auth_challenge':
          await this.handleAuthChallenge(message);
          return;
          
        case 'auth_result':
          this.handleAuthResult(message);
          return;
          
        case 'response':
          // 处理新协议的响应消息
          await this.handleServerResponse(message);
          return;
      }
      
      // 检查是否需要认证但未认证
      if (this.authState === 'authenticating') {
        console.warn('认证中，暂时忽略业务消息:', message.type);
        return;
      }
      
      // 提取请求信息
      const actionType = message.action || message.type;
      const payload = message.payload || message;
      const requestId = payload.requestId || message.requestId;
      
      // === 保护层检查 ===
      
      // 1. 速率限制检查
      if (this.rateLimiter) {
        const rateLimitResult = this.rateLimiter.check();
        if (!rateLimitResult.allowed) {
          console.warn(`[RateLimit] 请求被限制: ${actionType}`, rateLimitResult.reason);
          this.sendMessage({
            type: 'error',
            message: rateLimitResult.reason,
            requestId: requestId,
            code: 'RATE_LIMITED',
            retryAfter: rateLimitResult.retryAfter
          });
          return;
        }
      }
      
      // 2. 请求去重检查
      if (this.deduplicator && requestId) {
        const dedupResult = this.deduplicator.checkRequest(requestId);
        if (dedupResult.isDuplicate) {
          console.warn(`[Dedup] 重复请求被跳过: ${requestId}`);
          // 不发送响应，等待原请求完成
          return;
        }
        // 标记请求开始处理
        this.deduplicator.markProcessing(requestId);
      }
      
      // 3. 队列容量检查
      if (this.queueManager && requestId) {
        const queueResult = this.queueManager.add(requestId, actionType, { tabId: payload.tabId });
        if (!queueResult.accepted) {
          console.warn(`[Queue] 队列已满，请求被拒绝: ${requestId}`);
          this.sendMessage({
            type: 'error',
            message: queueResult.reason,
            requestId: requestId,
            code: 'QUEUE_FULL',
            queueSize: queueResult.queueSize
          });
          // 移除去重标记
          if (this.deduplicator) {
            this.deduplicator.markCompleted(requestId);
          }
          return;
        }
      }
      
      // === 处理业务消息 ===
      switch (actionType) {
        case 'open_url':
          await this.handleOpenUrl(payload);
          break;
          
        case 'close_tab':
          await this.handleCloseTab(payload);
          break;
          
        case 'get_html':
          await this.handleGetHtml(payload);
          break;
          
        case 'execute_script':
          await this.handleExecuteScript(payload);
          break;
          
        case 'inject_css':
          await this.handleInjectCss(payload);
          break;
          
        case 'get_cookies':
          await this.handleGetCookies(payload);
          break;
        
        case 'get_cookies_by_domain':
          await this.handleGetCookiesByDomain(payload);
          break;
          
        case 'upload_file_to_tab':
          await this.handleUploadFileToTab(payload);
          break;
          
        case 'subscribe_events':
          await this.handleSubscribeEvents(payload);
          break;
          
        case 'unsubscribe_events':
          await this.handleUnsubscribeEvents(payload);
          break;
          
        default:
          console.warn('未知消息类型:', actionType);
          // 清理队列和去重标记
          if (this.queueManager && requestId) {
            this.queueManager.remove(requestId);
          }
          if (this.deduplicator && requestId) {
            this.deduplicator.markCompleted(requestId);
          }
          break;
      }
    } catch (error) {
      console.error('处理服务器消息时出错:', error);
    }
  }

  /**
   * 处理服务器响应消息（新协议）
   * 支持服务端 v2.0 新增的状态：
   * - pending: 请求已注册，等待处理
   * - processing: 请求正在处理中
   * - completed: 请求成功完成
   * - timeout: 请求超时（服务端 60 秒超时）
   * - error: 请求发生错误
   * - rate_limited: 触发服务端限流
   */
  async handleServerResponse(message) {
    const { requestId, status, data, error, retryAfter, deduplicated, existingRequestId } = message;
    
    // 处理请求去重响应
    if (deduplicated && existingRequestId) {
      console.log(`[ServerResponse] 请求 ${requestId} 被去重，使用已有请求 ${existingRequestId}`);
      // 如果有待处理的回调，更新为使用已有请求的 ID
      if (this.pendingRequests.has(requestId)) {
        const callback = this.pendingRequests.get(requestId);
        this.pendingRequests.delete(requestId);
        // 将回调转移到已有请求
        if (!this.pendingRequests.has(existingRequestId)) {
          this.pendingRequests.set(existingRequestId, callback);
        }
      }
      return;
    }
    
    // 根据状态处理
    switch (status) {
      case 'pending':
        // 请求已注册，等待处理 - 无需特殊处理
        console.log(`[ServerResponse] 请求 ${requestId} 已注册，等待处理`);
        break;
        
      case 'processing':
        // 请求正在处理中 - 更新本地状态
        console.log(`[ServerResponse] 请求 ${requestId} 正在处理中`);
        break;
        
      case 'completed':
        // 请求成功完成
        console.log(`[ServerResponse] 请求 ${requestId} 成功完成:`, data);
        this.resolveRequest(requestId, { status, data });
        break;
        
      case 'timeout':
        // 服务端超时
        console.warn(`[ServerResponse] 请求 ${requestId} 服务端超时`);
        this.resolveRequest(requestId, { 
          status: 'timeout', 
          error: error || '服务端请求超时（60秒）'
        });
        break;
        
      case 'rate_limited':
        // 触发服务端限流
        console.warn(`[ServerResponse] 请求 ${requestId} 触发服务端限流，${retryAfter} 秒后重试`);
        this.handleServerRateLimit(retryAfter);
        this.resolveRequest(requestId, { 
          status: 'rate_limited', 
          error: `服务端限流，请 ${retryAfter} 秒后重试`,
          retryAfter 
        });
        break;
        
      case 'error':
        console.error(`[ServerResponse] 请求 ${requestId} 失败:`, error);
        
        // 检查是否是认证错误
        if (error === 'AUTH_REQUIRED' || error === 'AUTH_FAILED') {
          console.log('会话已过期，需要重新认证');
          this.authState = 'disconnected';
          this.sessionId = null;
          // 重新连接以进行认证
          this.reconnectWithNewSettings();
        }
        
        this.resolveRequest(requestId, { status: 'error', error });
        break;
        
      default:
        // 未知状态，按旧协议处理
        console.log(`[ServerResponse] 请求 ${requestId} 状态: ${status}`, data);
        this.resolveRequest(requestId, { status, data, error });
    }
  }
  
  /**
   * 解析请求并执行回调
   * @param {string} requestId - 请求 ID
   * @param {Object} result - 结果对象
   */
  resolveRequest(requestId, result) {
    // 清理队列和去重标记
    if (this.queueManager && requestId) {
      this.queueManager.remove(requestId);
    }
    if (this.deduplicator && requestId) {
      this.deduplicator.markCompleted(requestId);
    }
    
    // 如果有待处理的请求回调，执行它
    if (this.pendingRequests.has(requestId)) {
      const callback = this.pendingRequests.get(requestId);
      this.pendingRequests.delete(requestId);
      if (callback) {
        callback(result);
      }
    }
  }
  
  /**
   * 处理服务端限流信号
   * @param {number} retryAfter - 重试等待秒数
   */
  handleServerRateLimit(retryAfter) {
    const waitMs = (retryAfter || 5) * 1000;
    
    // 暂时阻止本地发送请求
    if (this.rateLimiter) {
      // 设置本地限流器的阻止状态
      this.rateLimiter.blockedUntil = Date.now() + waitMs;
      console.log(`[RateLimit] 服务端限流，本地限流器已同步，${retryAfter} 秒后解除`);
    }
    
    // 广播状态更新
    this.broadcastStatusUpdate();
  }

  /**
   * 处理打开URL请求
   * 带超时保护和标签页去重
   */
  async handleOpenUrl(message) {
    const { url, tabId, windowId, requestId } = message;
    const timeout = this.securityConfig.requestTimeout || 30000;
    
    try {
      let resultTabId;
      let isExistingTab = false;
      
      // 如果没有指定 tabId，检查是否已有相同 URL 的标签页（去重）
      if (!tabId && this.deduplicator) {
        const existingCheck = this.deduplicator.checkUrlTab(url);
        if (existingCheck.hasExisting) {
          // 验证标签页是否仍然存在
          try {
            const existingTab = await browser.tabs.get(existingCheck.tabId);
            if (existingTab && existingTab.url === url) {
              console.log(`[OpenUrl] 使用已存在的标签页 ${existingCheck.tabId} (URL: ${url})`);
              resultTabId = existingCheck.tabId;
              isExistingTab = true;
            }
          } catch (e) {
            // 标签页不存在，继续创建新的
          }
        }
      }
      
      if (!resultTabId) {
        if (tabId) {
          // 更新现有标签页
          await browser.tabs.update(parseInt(tabId), { url: url });
          resultTabId = tabId;
        } else {
          // 创建新标签页
          const createProperties = { url: url };
          if (windowId) {
            createProperties.windowId = parseInt(windowId);
          }
          
          const tab = await browser.tabs.create(createProperties);
          resultTabId = tab.id;
          
          // 缓存 URL 与标签页的映射
          if (this.deduplicator) {
            this.deduplicator.cacheUrlTab(url, resultTabId);
          }
        }
      }
      
      // 等待页面加载完成（带超时）
      if (!isExistingTab) {
        await this.withTimeout(
          this.waitForTabLoad(resultTabId),
          timeout,
          `页面加载超时`
        );
      }
      
      // 获取cookies（带超时）
      const cookies = await this.withTimeout(
        this.getTabCookies(resultTabId),
        10000, // cookies 获取使用较短的超时
        `获取Cookies超时`
      ).catch(err => {
        console.warn('获取Cookies失败:', err.message);
        return []; // cookies 获取失败不影响主流程
      });
      
      // 发送完成响应
      this.sendMessage({
        type: 'open_url_complete',
        tabId: resultTabId,
        url: url,
        cookies: cookies,
        isExistingTab: isExistingTab,
        requestId: requestId,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error('处理打开URL请求时出错:', error);
      this.sendMessage({
        type: 'error',
        message: error.message,
        requestId: requestId,
        code: error.message.includes('超时') ? 'TIMEOUT' : 'OPEN_URL_ERROR'
      });
    } finally {
      // 从队列中移除请求
      if (this.queueManager && requestId) {
        this.queueManager.remove(requestId);
      }
      if (this.deduplicator && requestId) {
        this.deduplicator.markCompleted(requestId);
      }
    }
  }

  /**
   * 处理关闭标签页请求
   */
  async handleCloseTab(message) {
    try {
      const { tabId, requestId } = message;
      
      await browser.tabs.remove(parseInt(tabId));
      
      this.sendMessage({
        type: 'close_tab_complete',
        tabId: tabId,
        requestId: requestId,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error('处理关闭标签页请求时出错:', error);
      this.sendMessage({
        type: 'error',
        message: error.message,
        requestId: message.requestId
      });
    }
  }

  /**
   * 处理获取HTML请求
   * 带超时保护
   */
  async handleGetHtml(message) {
    const { tabId, requestId } = message;
    const timeout = this.securityConfig.requestTimeout || 30000;
    
    try {
      // 使用超时包装器获取 HTML
      const results = await this.withTimeout(
        browser.tabs.executeScript(parseInt(tabId), {
          code: 'document.documentElement.outerHTML'
        }),
        timeout,
        `获取HTML超时`
      );
      
      const html = results[0] || '';
      
      // 如果HTML太大，分块发送
      if (html.length > 100000) { // 100KB
        await this.sendHtmlInChunks(tabId, html, requestId);
      } else {
        this.sendMessage({
          type: 'tab_html_complete',
          tabId: tabId,
          html: html,
          requestId: requestId,
          timestamp: new Date().toISOString()
        });
      }
      
    } catch (error) {
      console.error('处理获取HTML请求时出错:', error);
      this.sendMessage({
        type: 'error',
        message: error.message,
        requestId: requestId,
        code: error.message.includes('超时') ? 'TIMEOUT' : 'HTML_ERROR'
      });
    } finally {
      // 从队列中移除请求
      if (this.queueManager && requestId) {
        this.queueManager.remove(requestId);
      }
      if (this.deduplicator && requestId) {
        this.deduplicator.markCompleted(requestId);
      }
    }
  }

  /**
   * 分块发送HTML内容
   */
  async sendHtmlInChunks(tabId, html, requestId) {
    const chunkSize = 50000; // 50KB per chunk
    const totalChunks = Math.ceil(html.length / chunkSize);
    
    console.log(`HTML内容较大(${html.length}字符)，将分${totalChunks}块发送`);
    
    // 发送所有分块
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, html.length);
      const chunkData = html.substring(start, end);
      
      this.sendMessage({
        type: 'tab_html_chunk',
        tabId: tabId,
        chunkIndex: i,
        chunkData: chunkData,
        totalChunks: totalChunks,
        requestId: requestId,
        timestamp: new Date().toISOString()
      });
      
      // 小延迟避免消息过快
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    
    // 发送完成消息
    this.sendMessage({
      type: 'tab_html_complete',
      tabId: tabId,
      html: html,
      totalChunks: totalChunks,
      requestId: requestId,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * 处理执行脚本请求
   * 带超时保护，确保在超时后返回错误响应
   */
  async handleExecuteScript(message) {
    const { tabId, code, requestId } = message;
    const timeout = this.securityConfig.requestTimeout || 30000;
    
    try {
      // 包装代码以支持 Promise 等待
      const wrappedCode = `
        (async function() {
          try {
            const result = eval(${JSON.stringify(code)});
            // 检测返回值是否为 Promise（thenable），如果是则等待
            if (result && typeof result.then === 'function') {
              return await result;
            }
            return result;
          } catch (error) {
            throw new Error('脚本执行错误: ' + error.message);
          }
        })();
      `;
      
      // 使用超时包装器执行脚本
      const results = await this.withTimeout(
        browser.tabs.executeScript(parseInt(tabId), { code: wrappedCode }),
        timeout,
        `脚本执行超时`
      );
      
      this.sendMessage({
        type: 'execute_script_complete',
        tabId: tabId,
        result: results[0],
        requestId: requestId,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error('处理执行脚本请求时出错:', error);
      this.sendMessage({
        type: 'error',
        message: error.message,
        requestId: requestId,
        code: error.message.includes('超时') ? 'TIMEOUT' : 'SCRIPT_ERROR'
      });
    } finally {
      // 从队列中移除请求
      if (this.queueManager && requestId) {
        this.queueManager.remove(requestId);
      }
      if (this.deduplicator && requestId) {
        this.deduplicator.markCompleted(requestId);
      }
    }
  }

  /**
   * 处理注入CSS请求
   */
  async handleInjectCss(message) {
    try {
      const { tabId, css, requestId } = message;
      
      await browser.tabs.insertCSS(parseInt(tabId), {
        code: css
      });
      
      this.sendMessage({
        type: 'inject_css_complete',
        tabId: tabId,
        requestId: requestId,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error('处理注入CSS请求时出错:', error);
      this.sendMessage({
        type: 'error',
        message: error.message,
        requestId: message.requestId
      });
    }
  }

  /**
   * 处理获取Cookies请求
   * 注意：cookies将被发送到服务器存储在独立的cookies表中（不再关联特定tab_id）
   */
  async handleGetCookies(message) {
    try {
      const { tabId, requestId } = message;
      
      const tab = await browser.tabs.get(parseInt(tabId));
      const cookies = await this.getTabCookies(tabId, tab.url);
      
      // 只返回获取到的cookies，不触发保存
      // 服务器端会将这些cookies存储到独立的cookies表中
      this.sendMessage({
        type: 'get_cookies_complete',
        tabId: tabId,
        url: tab.url,
        cookies: cookies,
        requestId: requestId,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error('处理获取Cookies请求时出错:', error);
      this.sendMessage({
        type: 'error',
        message: error.message,
        requestId: message.requestId
      });
    }
  }

  /**
   * 处理按域名获取Cookies请求（不需要tabId，直接从浏览器获取）
   */
  async handleGetCookiesByDomain(message) {
    try {
      const { domain, includeSubdomains = true, requestId } = message;
      
      if (!domain) {
        this.sendMessage({
          type: 'error',
          message: '缺少域名参数',
          requestId: requestId
        });
        return;
      }
      
      console.log(`[Cookie获取] 按域名获取cookies: ${domain}, 包含子域名: ${includeSubdomains}`);
      
      const cookies = await this.getCookiesByDomain(domain, includeSubdomains);
      
      this.sendMessage({
        type: 'get_cookies_by_domain_complete',
        domain: domain,
        includeSubdomains: includeSubdomains,
        cookies: cookies,
        total: cookies.length,
        requestId: requestId,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error('处理按域名获取Cookies请求时出错:', error);
      this.sendMessage({
        type: 'error',
        message: error.message,
        requestId: message.requestId
      });
    }
  }

  /**
   * 按域名获取cookies（直接从浏览器获取，不需要tabId）
   * @param {string} domain 域名，如 "xiaohongshu.com"
   * @param {boolean} includeSubdomains 是否包含子域名
   * @returns {Promise<Array>} cookies数组
   */
  async getCookiesByDomain(domain, includeSubdomains = true) {
    try {
      console.log(`[Cookie获取] 开始按域名获取cookies: ${domain}`);
      
      const allCookies = [];
      let fetchStats = {
        mainDomain: 0,
        parentDomain: 0,
        subdomains: 0,
        stores: 0,
        total: 0,
        errors: 0
      };
      
      // 1. 获取精确域名的cookies
      try {
        const mainCookies = await browser.cookies.getAll({ domain: domain });
        allCookies.push(...mainCookies);
        fetchStats.mainDomain = mainCookies.length;
        console.log(`[Cookie获取] 主域名 ${domain}: ${mainCookies.length} 个cookies`);
      } catch (error) {
        console.warn(`[Cookie获取] 主域名获取失败:`, error);
        fetchStats.errors++;
      }
      
      // 2. 获取带点前缀的域名cookies（如 .xiaohongshu.com）
      try {
        const dotDomain = domain.startsWith('.') ? domain : '.' + domain;
        const dotCookies = await browser.cookies.getAll({ domain: dotDomain });
        allCookies.push(...dotCookies);
        fetchStats.parentDomain = dotCookies.length;
        console.log(`[Cookie获取] 点域名 ${dotDomain}: ${dotCookies.length} 个cookies`);
      } catch (error) {
        console.debug(`[Cookie获取] 点域名获取失败:`, error);
        fetchStats.errors++;
      }
      
      // 3. 如果包含子域名，获取常见子域名的cookies
      if (includeSubdomains) {
        const baseDomain = domain.startsWith('.') ? domain.slice(1) : domain;
        const subdomainPatterns = [
          'www.' + baseDomain,
          'api.' + baseDomain,
          'm.' + baseDomain,
          'mobile.' + baseDomain,
          'app.' + baseDomain,
          'cdn.' + baseDomain,
          'edith.' + baseDomain,  // 小红书特有
          'sns-webpic-qc.' + baseDomain,
          'fe-video-qc.' + baseDomain
        ];
        
        let subdomainCount = 0;
        for (const subdomain of subdomainPatterns) {
          try {
            const subCookies = await browser.cookies.getAll({ domain: subdomain });
            if (subCookies.length > 0) {
              allCookies.push(...subCookies);
              subdomainCount += subCookies.length;
              console.log(`[Cookie获取] 子域名 ${subdomain}: ${subCookies.length} 个cookies`);
            }
          } catch (error) {
            // 子域名获取失败是正常的，静默处理
          }
        }
        fetchStats.subdomains = subdomainCount;
      }
      
      // 4. 尝试从不同的cookie存储分区获取
      try {
        const stores = await browser.cookies.getAllCookieStores();
        let storeCount = 0;
        for (const store of stores) {
          try {
            const storeCookies = await browser.cookies.getAll({ 
              domain: domain,
              storeId: store.id 
            });
            if (storeCookies.length > 0) {
              allCookies.push(...storeCookies);
              storeCount += storeCookies.length;
            }
          } catch (error) {
            // 静默处理
          }
        }
        fetchStats.stores = storeCount;
      } catch (error) {
        console.debug('[Cookie获取] 存储分区获取失败:', error);
      }
      
      // 5. 去重和验证
      const uniqueCookies = this.deduplicateCookies(allCookies);
      const validatedCookies = this.validateCookies(uniqueCookies);
      fetchStats.total = validatedCookies.length;
      
      console.log(`[Cookie获取] 按域名完成 - 原始: ${allCookies.length}, 去重后: ${uniqueCookies.length}, 验证后: ${validatedCookies.length}`);
      console.log(`[Cookie获取] 统计:`, fetchStats);
      
      return validatedCookies;
      
    } catch (error) {
      console.error('[Cookie获取] 按域名获取cookies时出错:', error);
      return [];
    }
  }

  /**
   * 获取标签页的cookies（增强版 - 获取所有相关域名的cookies，优化错误处理）
   */
  async getTabCookies(tabId, url = null) {
    try {
      if (!url) {
        const tab = await browser.tabs.get(parseInt(tabId));
        url = tab.url;
      }
      
      // URL验证
      if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
        console.warn(`[Cookie获取] 跳过非HTTP(S)协议的URL: ${url}`);
        return [];
      }
      
      console.log(`[Cookie获取] 开始获取标签页 ${tabId} 的cookies，URL: ${url}`);
      
      const urlObj = new URL(url);
      const allCookies = [];
      let fetchStats = {
        mainDomain: 0,
        parentDomain: 0,
        subdomains: 0,
        urlBased: 0,
        stores: 0,
        total: 0,
        errors: 0
      };
      
      // 1. 获取当前域名的cookies
      try {
        const mainDomainCookies = await browser.cookies.getAll({
          domain: urlObj.hostname
        });
        allCookies.push(...mainDomainCookies);
        fetchStats.mainDomain = mainDomainCookies.length;
        console.log(`[Cookie获取] 主域名 ${urlObj.hostname}: ${mainDomainCookies.length} 个cookies`);
      } catch (error) {
        console.warn(`[Cookie获取] 主域名获取失败:`, error);
        fetchStats.errors++;
      }
      
      // 2. 获取父域名的cookies（如 .example.com）
      const domainParts = urlObj.hostname.split('.');
      if (domainParts.length > 2) {
        const parentDomain = '.' + domainParts.slice(-2).join('.');
        try {
          const parentDomainCookies = await browser.cookies.getAll({
            domain: parentDomain
          });
          allCookies.push(...parentDomainCookies);
          fetchStats.parentDomain = parentDomainCookies.length;
          console.log(`[Cookie获取] 父域名 ${parentDomain}: ${parentDomainCookies.length} 个cookies`);
        } catch (error) {
          console.debug(`[Cookie获取] 父域名 ${parentDomain} 获取失败:`, error);
          fetchStats.errors++;
        }
      }
      
      // 3. 获取常见子域名的cookies
      const subdomainPatterns = [
        'www.' + urlObj.hostname,
        'api.' + urlObj.hostname,
        'm.' + urlObj.hostname,
        'mobile.' + urlObj.hostname,
        'app.' + urlObj.hostname,
        'cdn.' + urlObj.hostname
      ];
      
      let subdomainCount = 0;
      for (const subdomain of subdomainPatterns) {
        try {
          const subdomainCookies = await browser.cookies.getAll({
            domain: subdomain
          });
          if (subdomainCookies.length > 0) {
            allCookies.push(...subdomainCookies);
            subdomainCount += subdomainCookies.length;
            console.log(`[Cookie获取] 子域名 ${subdomain}: ${subdomainCookies.length} 个cookies`);
          }
        } catch (error) {
          console.debug(`[Cookie获取] 子域名 ${subdomain} 获取失败:`, error);
          fetchStats.errors++;
        }
      }
      fetchStats.subdomains = subdomainCount;
      
      // 4. 获取当前URL的所有cookies（包括第三方）
      try {
        const urlCookies = await browser.cookies.getAll({
          url: url
        });
        allCookies.push(...urlCookies);
        fetchStats.urlBased = urlCookies.length;
        console.log(`[Cookie获取] URL相关cookies: ${urlCookies.length} 个`);
      } catch (error) {
        console.debug('[Cookie获取] URL cookies获取失败:', error);
        fetchStats.errors++;
      }
      
      // 5. 尝试获取不同存储分区的cookies
      try {
        const storeIds = await browser.cookies.getAllCookieStores();
        let storeCount = 0;
        for (const store of storeIds) {
          try {
            const storeCookies = await browser.cookies.getAll({
              url: url,
              storeId: store.id
            });
            if (storeCookies.length > 0) {
              allCookies.push(...storeCookies);
              storeCount += storeCookies.length;
              console.log(`[Cookie获取] 存储分区 ${store.id}: ${storeCookies.length} 个cookies`);
            }
          } catch (error) {
            console.debug(`[Cookie获取] 存储分区 ${store.id} 获取失败:`, error);
            fetchStats.errors++;
          }
        }
        fetchStats.stores = storeCount;
      } catch (error) {
        console.debug('[Cookie获取] 存储分区获取失败:', error);
        fetchStats.errors++;
      }
      
      // 6. 去重处理和数据验证
      const uniqueCookies = this.deduplicateCookies(allCookies);
      const validatedCookies = this.validateCookies(uniqueCookies);
      fetchStats.total = validatedCookies.length;
      
      console.log(`[Cookie获取] 完成 - 原始: ${allCookies.length}, 去重后: ${uniqueCookies.length}, 验证后: ${validatedCookies.length}`);
      console.log(`[Cookie获取] 统计:`, fetchStats);
      
      // 7. 分析cookie域名分布
      const domainStats = this.analyzeCookieDomains(validatedCookies);
      console.log(`[Cookie获取] 域名分布:`, domainStats);
      
      return validatedCookies;
      
    } catch (error) {
      console.error('[Cookie获取] 获取cookies时出错:', error);
      return [];
    }
  }

  /**
   * Cookie去重处理
   */
  deduplicateCookies(cookies) {
    const seen = new Set();
    const uniqueCookies = [];
    
    for (const cookie of cookies) {
      // 使用 name + domain + path 作为唯一标识
      const key = `${cookie.name}@${cookie.domain}${cookie.path || '/'}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueCookies.push(cookie);
      }
    }
    
    return uniqueCookies;
  }

  /**
   * Cookie数据验证和清理
   */
  validateCookies(cookies) {
    const validCookies = [];
    let invalidCount = 0;
    
    for (const cookie of cookies) {
      try {
        // 基本字段验证
        if (!cookie.name || typeof cookie.name !== 'string') {
          throw new Error('Cookie名称无效');
        }
        
        // 长度验证
        if (cookie.name.length > 4096) {
          throw new Error('Cookie名称过长');
        }
        
        if (cookie.value && cookie.value.length > 4096) {
          throw new Error('Cookie值过长');
        }
        
        // 域名验证
        if (cookie.domain && typeof cookie.domain === 'string') {
          // 简单的域名格式验证
          if (!/^[a-zA-Z0-9.-]+$/.test(cookie.domain.replace(/^\./, ''))) {
            throw new Error('Cookie域名格式无效');
          }
        }
        
        // sameSite值验证和标准化
        if (cookie.sameSite) {
          const validSameSiteValues = ['strict', 'lax', 'none', 'no_restriction', 'unspecified'];
          if (!validSameSiteValues.includes(cookie.sameSite.toLowerCase())) {
            console.warn(`[Cookie验证] 未知的sameSite值: ${cookie.sameSite}，将设为unspecified`);
            cookie.sameSite = 'unspecified';
          }
        }
        
        validCookies.push(cookie);
        
      } catch (error) {
        invalidCount++;
        console.warn(`[Cookie验证] 跳过无效cookie ${cookie.name}: ${error.message}`);
      }
    }
    
    if (invalidCount > 0) {
      console.log(`[Cookie验证] 跳过了 ${invalidCount} 个无效cookies`);
    }
    
    return validCookies;
  }

  /**
   * 分析cookie域名分布
   */
  analyzeCookieDomains(cookies) {
    const domainStats = {};
    cookies.forEach(cookie => {
      const domain = cookie.domain || 'unknown';
      domainStats[domain] = (domainStats[domain] || 0) + 1;
    });
    return domainStats;
  }

  /**
   * 处理文件上传到标签页请求
   */
  async handleUploadFileToTab(message) {
    try {
      const { tabId, files, targetSelector, requestId } = message;
      
      console.log(`开始处理文件上传请求: tabId=${tabId}, files=${files.length}个, requestId=${requestId}`);
      
      // 验证参数
      if (!tabId || !files || !Array.isArray(files) || files.length === 0) {
        throw new Error('缺少必要参数: tabId, files');
      }
      
      // 转换Base64数据为File对象
      const fileObjects = [];
      for (let i = 0; i < files.length; i++) {
        const fileData = files[i];
        
        try {
          // 解码Base64数据
          const base64Data = fileData.base64.replace(/^data:[^;]+;base64,/, '');
          const binaryData = atob(base64Data);
          
          // 创建Uint8Array
          const uint8Array = new Uint8Array(binaryData.length);
          for (let j = 0; j < binaryData.length; j++) {
            uint8Array[j] = binaryData.charCodeAt(j);
          }
          
          // 创建File对象
          const file = new File([uint8Array], fileData.name, {
            type: fileData.type,
            lastModified: Date.now()
          });
          
          fileObjects.push(file);
          console.log(`文件转换成功: ${fileData.name} (${Math.round(fileData.size / 1024)}KB)`);
          
        } catch (error) {
          console.error(`文件转换失败: ${fileData.name}`, error);
          throw new Error(`文件转换失败: ${fileData.name} - ${error.message}`);
        }
      }
      
      // 注入脚本到目标标签页来处理文件上传
      const uploadScript = this.generateFileUploadScript(fileObjects, targetSelector || 'input[type="file"]');
      
      const results = await browser.tabs.executeScript(parseInt(tabId), {
        code: uploadScript
      });
      
      const uploadResult = results[0];
      
      if (uploadResult && uploadResult.success) {
        console.log(`文件上传成功: tabId=${tabId}, 上传了${fileObjects.length}个文件`);
        
        // 发送成功响应
        this.sendMessage({
          type: 'upload_file_to_tab_complete',
          tabId: tabId,
          uploadedFiles: fileObjects.map(file => ({
            name: file.name,
            size: file.size,
            type: file.type,
            lastModified: file.lastModified
          })),
          targetSelector: targetSelector,
          message: `成功上传 ${fileObjects.length} 个文件`,
          requestId: requestId,
          timestamp: new Date().toISOString()
        });
        
      } else {
        throw new Error(uploadResult?.error || '文件上传失败');
      }
      
    } catch (error) {
      console.error('处理文件上传请求时出错:', error);
      this.sendMessage({
        type: 'error',
        message: error.message,
        requestId: message.requestId
      });
    }
  }

  /**
   * 生成文件上传脚本
   */
  generateFileUploadScript(fileObjects, targetSelector) {
    return `
(function() {
  try {
    console.log('开始执行文件上传脚本...');
    
    // 查找目标文件输入元素
    const fileInput = document.querySelector('${targetSelector}');
    
    if (!fileInput) {
      // 如果没有找到指定选择器，尝试查找其他可能的文件输入元素
      const alternativeSelectors = [
        'input[type="file"]',
        'input[accept*="image"]',
        'input[accept*="file"]',
        '[data-testid*="upload"]',
        '[class*="upload"] input',
        '[class*="file"] input'
      ];
      
      let found = false;
      for (const selector of alternativeSelectors) {
        const element = document.querySelector(selector);
        if (element) {
          console.log('找到替代文件输入元素:', selector);
          fileInput = element;
          found = true;
          break;
        }
      }
      
      if (!found) {
        throw new Error('未找到文件输入元素: ${targetSelector}');
      }
    }
    
    console.log('找到文件输入元素:', fileInput);
    
    // 创建文件列表
    const fileList = ${JSON.stringify(fileObjects.map(file => ({
      name: file.name,
      size: file.size,
      type: file.type,
      lastModified: file.lastModified
    })))};
    
    // 创建DataTransfer对象来模拟文件选择
    const dataTransfer = new DataTransfer();
    
    // 由于安全限制，我们无法直接创建File对象，
    // 但我们可以触发文件输入的点击事件，让用户手动选择文件
    // 或者使用其他方法来设置文件
    
    // 方法1: 尝试直接设置files属性（可能受到安全限制）
    try {
      // 这种方法在某些情况下可能不起作用，因为浏览器的安全限制
      const files = fileList.map(fileData => {
        // 注意：这里我们无法直接从扩展传递File对象到页面脚本
        // 需要使用其他方法
        return null;
      }).filter(f => f !== null);
      
      if (files.length > 0) {
        files.forEach(file => dataTransfer.items.add(file));
        fileInput.files = dataTransfer.files;
      }
    } catch (error) {
      console.warn('直接设置files属性失败:', error.message);
    }
    
    // 方法2: 触发文件输入的各种事件
    try {
      // 聚焦到文件输入元素
      fileInput.focus();
      
      // 触发点击事件（这会打开文件选择对话框）
      fileInput.click();
      
      // 触发change事件
      const changeEvent = new Event('change', { bubbles: true });
      fileInput.dispatchEvent(changeEvent);
      
      // 触发input事件
      const inputEvent = new Event('input', { bubbles: true });
      fileInput.dispatchEvent(inputEvent);
      
      console.log('文件输入事件已触发');
      
    } catch (error) {
      console.error('触发文件输入事件失败:', error);
      throw error;
    }
    
    // 方法3: 尝试拖拽模拟
    try {
      // 创建拖拽事件
      const dragEnterEvent = new DragEvent('dragenter', {
        bubbles: true,
        dataTransfer: dataTransfer
      });
      
      const dragOverEvent = new DragEvent('dragover', {
        bubbles: true,
        dataTransfer: dataTransfer
      });
      
      const dropEvent = new DragEvent('drop', {
        bubbles: true,
        dataTransfer: dataTransfer
      });
      
      // 触发拖拽事件序列
      fileInput.dispatchEvent(dragEnterEvent);
      fileInput.dispatchEvent(dragOverEvent);
      fileInput.dispatchEvent(dropEvent);
      
      console.log('拖拽事件已触发');
      
    } catch (error) {
      console.warn('拖拽事件触发失败:', error.message);
    }
    
    // 返回成功结果
    return {
      success: true,
      message: '文件上传脚本执行完成，已触发文件输入相关事件',
      targetElement: fileInput.tagName + (fileInput.className ? '.' + fileInput.className : ''),
      fileCount: fileList.length
    };
    
  } catch (error) {
    console.error('文件上传脚本执行失败:', error);
    return {
      success: false,
      error: error.message
    };
  }
})();
`;
  }

  /**
   * 处理事件订阅请求
   * 支持服务器端的事件订阅机制
   */
  async handleSubscribeEvents(message) {
    try {
      const { events = [], requestId } = message;
      
      // 初始化事件订阅存储
      if (!this.subscribedEvents) {
        this.subscribedEvents = new Set();
      }
      
      // 添加订阅的事件类型
      events.forEach(eventType => {
        this.subscribedEvents.add(eventType);
        console.log(`[SubscribeEvents] 已订阅事件: ${eventType}`);
      });
      
      // 发送订阅成功响应
      this.sendMessage({
        type: 'subscribe_events_response',
        requestId: requestId,
        status: 'success',
        subscribedEvents: Array.from(this.subscribedEvents),
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error('处理事件订阅请求时出错:', error);
      this.sendMessage({
        type: 'error',
        message: error.message,
        requestId: message.requestId
      });
    } finally {
      // 从队列中移除请求
      if (this.queueManager && message.requestId) {
        this.queueManager.remove(message.requestId);
      }
      if (this.deduplicator && message.requestId) {
        this.deduplicator.markCompleted(message.requestId);
      }
    }
  }

  /**
   * 处理取消事件订阅请求
   */
  async handleUnsubscribeEvents(message) {
    try {
      const { events = [], requestId } = message;
      
      // 如果没有订阅存储，初始化
      if (!this.subscribedEvents) {
        this.subscribedEvents = new Set();
      }
      
      // 移除订阅的事件类型
      events.forEach(eventType => {
        this.subscribedEvents.delete(eventType);
        console.log(`[UnsubscribeEvents] 已取消订阅事件: ${eventType}`);
      });
      
      // 发送取消订阅成功响应
      this.sendMessage({
        type: 'unsubscribe_events_response',
        requestId: requestId,
        status: 'success',
        unsubscribedEvents: events,
        remainingSubscriptions: Array.from(this.subscribedEvents),
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error('处理取消事件订阅请求时出错:', error);
      this.sendMessage({
        type: 'error',
        message: error.message,
        requestId: message.requestId
      });
    } finally {
      // 从队列中移除请求
      if (this.queueManager && message.requestId) {
        this.queueManager.remove(message.requestId);
      }
      if (this.deduplicator && message.requestId) {
        this.deduplicator.markCompleted(message.requestId);
      }
    }
  }

  /**
   * 等待标签页加载完成
   */
  async waitForTabLoad(tabId, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('等待标签页加载超时'));
      }, timeout);
      
      const checkStatus = async () => {
        try {
          const tab = await browser.tabs.get(parseInt(tabId));
          if (tab.status === 'complete') {
            clearTimeout(timeoutId);
            resolve(tab);
          } else {
            setTimeout(checkStatus, 500);
          }
        } catch (error) {
          clearTimeout(timeoutId);
          reject(error);
        }
      };
      
      checkStatus();
    });
  }

  /**
   * 设置标签页事件监听
   */
  setupTabListeners() {
    // 标签页创建
    browser.tabs.onCreated.addListener((tab) => {
      console.log('标签页创建:', tab.id, tab.url);
      setTimeout(() => this.sendTabsData(), 1000);
    });
    
    // 标签页更新
    browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.status === 'complete') {
        console.log('标签页加载完成:', tabId, tab.url);
        setTimeout(() => this.sendTabsData(), 500);
      }
    });
    
    // 标签页移除
    browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
      console.log('标签页移除:', tabId);
      setTimeout(() => this.sendTabsData(), 500);
    });
    
    // 标签页激活
    browser.tabs.onActivated.addListener((activeInfo) => {
      console.log('标签页激活:', activeInfo.tabId);
      setTimeout(() => this.sendTabsData(), 200);
    });
  }

  /**
   * 设置消息监听
   */
  setupMessageListeners() {
    // 监听来自popup和content script的消息
    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
      // 处理来自 Content Script 的安全中转请求
      if (message.type === 'CONTENT_SCRIPT_REQUEST') {
        // 安全验证：验证发送者是否为本扩展
        if (sender.id !== browser.runtime.id) {
          console.warn('[Background] 拒绝非法发送者的请求:', sender.id);
          sendResponse({ success: false, error: '非法发送者' });
          return true;
        }
        
        console.log(`[Background] 收到 Content Script 请求: ${message.action}`, {
          requestId: message.requestId,
          sourceUrl: message.sourceUrl,
          tabId: sender.tab?.id
        });
        
        // 处理请求（异步）
        this.handleContentScriptRequest(message, sender)
          .then(response => {
            console.log(`[Background] 请求处理完成: ${message.requestId}`, response.success);
            sendResponse(response);
          })
          .catch(error => {
            console.error(`[Background] 请求处理失败: ${message.requestId}`, error);
            sendResponse({ success: false, error: error.message });
          });
        
        return true; // 保持消息通道开放（异步响应）
      }
      
      // 原有的 popup 消息处理
      if (message.type === 'get_connection_status') {
        sendResponse({
          isConnected: this.isConnected,
          serverUrl: this.serverUrl,
          reconnectAttempts: this.reconnectAttempts,
          // 新增认证状态
          authState: this.authState,
          hasAuthKey: !!this.authSecretKey,
          sessionId: this.sessionId ? '***' : null, // 隐藏实际值
          sessionExpiresAt: this.sessionExpiresAt
        });
        return true; // 保持消息通道开放
      }
      
      // 获取认证状态
      if (message.type === 'get_auth_status') {
        sendResponse({
          authState: this.authState,
          hasAuthKey: !!this.authSecretKey,
          isAuthenticated: this.authState === 'authenticated',
          sessionExpiresAt: this.sessionExpiresAt
        });
        return true;
      }
      
      // 获取扩展状态（包含健康检查、限流等新信息）
      if (message.type === 'get_extended_status') {
        sendResponse(this.getExtendedStatus());
        return true;
      }
      
      // 保存认证密钥
      if (message.type === 'save_auth_key') {
        this.saveAuthKey(message.authKey)
          .then(() => {
            sendResponse({ success: true });
          })
          .catch(error => {
            sendResponse({ success: false, error: error.message });
          });
        return true;
      }
      
      // 清除认证密钥
      if (message.type === 'clear_auth_key') {
        this.clearAuthKey()
          .then(() => {
            sendResponse({ success: true });
          })
          .catch(error => {
            sendResponse({ success: false, error: error.message });
          });
        return true;
      }
      if (message.type === 'send_tabs_data') {
        this.sendTabsData();
        sendResponse({ success: true });
        return true;
      }
      if (message.type === 'reconnect') {
        this.reconnectWithNewSettings();
        sendResponse({ success: true });
        return true;
      }
      if (message.type === 'get_auto_connect') {
        sendResponse({ autoConnect: this.autoConnect });
        return true;
      }
      if (message.type === 'set_auto_connect') {
        this.autoConnect = message.autoConnect;
        if (!this.autoConnect) {
          // 如果关闭自动连接，停止当前重连
          this.stopAutoReconnect();
        } else if (!this.isConnected && !this.isReconnecting) {
          // 如果启用自动连接且未连接，立即尝试连接
          this.connect();
        }
        sendResponse({ success: true });
        return true;
      }
    });
  }

  /**
   * 处理来自 Content Script 的请求
   * 这是安全中转通信的核心处理方法
   * 
   * @param {Object} message 请求消息
   * @param {Object} sender 发送者信息
   * @returns {Promise<Object>} 响应对象
   */
  async handleContentScriptRequest(message, sender) {
    const { action, payload, requestId, sourceUrl } = message;
    
    try {
      // 验证操作是否在白名单中
      if (!this.securityConfig.allowedActions.includes(action)) {
        console.warn(`[Background] 拒绝不允许的操作: ${action}`);
        return { success: false, error: `不允许的操作: ${action}` };
      }
      
      // 敏感操作验证
      if (this.securityConfig.sensitiveActions.includes(action)) {
        const isValid = await this.validateSensitiveOperation(action, sender, payload);
        if (!isValid) {
          return { success: false, error: '敏感操作验证失败' };
        }
      }
      
      // 根据操作类型执行相应处理
      switch (action) {
        case 'get_tabs':
          return await this.handleGetTabsRequest(payload);
          
        case 'get_html':
          return await this.handleGetHtmlRequest(payload);
          
        case 'open_url':
          return await this.handleOpenUrlRequest(payload);
          
        case 'close_tab':
          return await this.handleCloseTabRequest(payload);
          
        case 'execute_script':
          return await this.handleExecuteScriptRequest(payload, sender);
          
        case 'get_cookies':
          return await this.handleGetCookiesRequest(payload);
        
        case 'get_cookies_by_domain':
          return await this.handleGetCookiesByDomainRequest(payload);
          
        case 'inject_css':
          return await this.handleInjectCssRequest(payload);
          
        case 'get_page_info':
          return await this.handleGetPageInfoRequest(payload, sender);
          
        case 'upload_file_to_tab':
          return await this.handleUploadFileRequest(payload);
          
        default:
          return { success: false, error: `未知操作: ${action}` };
      }
      
    } catch (error) {
      console.error(`[Background] 处理请求时出错: ${action}`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 验证敏感操作
   * 
   * @param {string} action 操作名称
   * @param {Object} sender 发送者信息
   * @param {Object} payload 请求载荷
   * @returns {Promise<boolean>} 是否允许操作
   */
  async validateSensitiveOperation(action, sender, payload) {
    // 检查请求来源 Tab 是否有权操作目标 Tab
    if (payload && payload.tabId && sender.tab) {
      const targetTabId = parseInt(payload.tabId);
      const sourceTabId = sender.tab.id;
      
      if (targetTabId !== sourceTabId) {
        console.warn(`[Background] 跨Tab敏感操作: ${action}`, {
          sourceTab: sourceTabId,
          targetTab: targetTabId,
          sourceUrl: sender.tab.url
        });
        // 目前允许跨Tab操作，但记录日志以便审计
        // 如果需要更严格的安全策略，可以在这里返回 false
      }
    }
    
    return true;
  }

  /**
   * 处理获取标签页列表请求
   */
  async handleGetTabsRequest(payload) {
    try {
      const tabs = await browser.tabs.query({});
      const activeTab = await browser.tabs.query({ active: true, currentWindow: true });
      
      const tabsData = tabs.map(tab => ({
        id: tab.id,
        url: tab.url || '',
        title: tab.title || '',
        isActive: activeTab.length > 0 && activeTab[0].id === tab.id,
        windowId: tab.windowId,
        index: tab.index,
        favIconUrl: tab.favIconUrl || null,
        status: tab.status || 'complete'
      }));
      
      return { 
        success: true, 
        data: {
          tabs: tabsData,
          activeTabId: activeTab.length > 0 ? activeTab[0].id : null
        }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * 处理获取HTML请求（通过 Content Script 中转）
   */
  async handleGetHtmlRequest(payload) {
    try {
      const tabId = payload?.tabId;
      if (!tabId) {
        return { success: false, error: '缺少 tabId 参数' };
      }
      
      const results = await browser.tabs.executeScript(parseInt(tabId), {
        code: 'document.documentElement.outerHTML'
      });
      
      return { 
        success: true, 
        data: { html: results[0] || '' }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * 处理打开URL请求（通过 Content Script 中转）
   */
  async handleOpenUrlRequest(payload) {
    try {
      const { url, tabId, windowId } = payload || {};
      
      if (!url) {
        return { success: false, error: '缺少 url 参数' };
      }
      
      let resultTabId;
      
      if (tabId) {
        await browser.tabs.update(parseInt(tabId), { url: url });
        resultTabId = parseInt(tabId);
      } else {
        const createProperties = { url: url };
        if (windowId) {
          createProperties.windowId = parseInt(windowId);
        }
        const tab = await browser.tabs.create(createProperties);
        resultTabId = tab.id;
      }
      
      return { 
        success: true, 
        data: { tabId: resultTabId, url: url }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * 处理关闭标签页请求（通过 Content Script 中转）
   */
  async handleCloseTabRequest(payload) {
    try {
      const tabId = payload?.tabId;
      if (!tabId) {
        return { success: false, error: '缺少 tabId 参数' };
      }
      
      await browser.tabs.remove(parseInt(tabId));
      
      return { 
        success: true, 
        data: { tabId: parseInt(tabId), closed: true }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * 处理执行脚本请求（通过 Content Script 中转）
   * 带超时保护
   */
  async handleExecuteScriptRequest(payload, sender) {
    const timeout = this.securityConfig.requestTimeout || 30000;
    
    try {
      const { tabId, code } = payload || {};
      
      if (!code) {
        return { success: false, error: '缺少 code 参数' };
      }
      
      // 如果没有指定 tabId，使用发送者的 tabId
      const targetTabId = tabId ? parseInt(tabId) : sender.tab?.id;
      
      if (!targetTabId) {
        return { success: false, error: '无法确定目标标签页' };
      }
      
      // 包装代码以支持 Promise 等待
      const wrappedCode = `
        (async function() {
          try {
            const result = eval(${JSON.stringify(code)});
            if (result && typeof result.then === 'function') {
              return await result;
            }
            return result;
          } catch (error) {
            throw new Error('脚本执行错误: ' + error.message);
          }
        })();
      `;
      
      // 使用超时包装器执行脚本
      const results = await this.withTimeout(
        browser.tabs.executeScript(targetTabId, { code: wrappedCode }),
        timeout,
        `脚本执行超时`
      );
      
      return { 
        success: true, 
        data: { result: results[0], tabId: targetTabId }
      };
    } catch (error) {
      return { 
        success: false, 
        error: error.message,
        code: error.message.includes('超时') ? 'TIMEOUT' : 'SCRIPT_ERROR'
      };
    }
  }

  /**
   * 处理获取Cookies请求（通过 Content Script 中转）
   */
  async handleGetCookiesRequest(payload) {
    try {
      const tabId = payload?.tabId;
      if (!tabId) {
        return { success: false, error: '缺少 tabId 参数' };
      }
      
      const tab = await browser.tabs.get(parseInt(tabId));
      const cookies = await this.getTabCookies(tabId, tab.url);
      
      return { 
        success: true, 
        data: { 
          cookies: cookies,
          url: tab.url,
          tabId: parseInt(tabId)
        }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * 处理按域名获取Cookies请求（通过 Content Script 中转）
   */
  async handleGetCookiesByDomainRequest(payload) {
    try {
      const { domain, includeSubdomains = true } = payload || {};
      
      if (!domain) {
        return { success: false, error: '缺少 domain 参数' };
      }
      
      const cookies = await this.getCookiesByDomain(domain, includeSubdomains);
      
      return { 
        success: true, 
        data: { 
          cookies: cookies,
          domain: domain,
          includeSubdomains: includeSubdomains,
          total: cookies.length
        }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * 处理注入CSS请求（通过 Content Script 中转）
   */
  async handleInjectCssRequest(payload) {
    try {
      const { tabId, css } = payload || {};
      
      if (!tabId || !css) {
        return { success: false, error: '缺少 tabId 或 css 参数' };
      }
      
      await browser.tabs.insertCSS(parseInt(tabId), {
        code: css
      });
      
      return { 
        success: true, 
        data: { tabId: parseInt(tabId), injected: true }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * 处理获取页面信息请求（通过 Content Script 中转）
   */
  async handleGetPageInfoRequest(payload, sender) {
    try {
      const tabId = payload?.tabId || sender.tab?.id;
      
      if (!tabId) {
        return { success: false, error: '无法确定目标标签页' };
      }
      
      const tab = await browser.tabs.get(parseInt(tabId));
      
      return { 
        success: true, 
        data: {
          tabId: tab.id,
          url: tab.url,
          title: tab.title,
          status: tab.status,
          favIconUrl: tab.favIconUrl
        }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * 处理文件上传请求（通过 Content Script 中转）
   */
  async handleUploadFileRequest(payload) {
    try {
      const { tabId, files, targetSelector } = payload || {};
      
      if (!tabId || !files || !Array.isArray(files)) {
        return { success: false, error: '缺少必要参数' };
      }
      
      // 复用现有的文件上传处理逻辑
      const uploadScript = this.generateFileUploadScript(files, targetSelector || 'input[type="file"]');
      
      const results = await browser.tabs.executeScript(parseInt(tabId), {
        code: uploadScript
      });
      
      const uploadResult = results[0];
      
      if (uploadResult && uploadResult.success) {
        return { 
          success: true, 
          data: uploadResult
        };
      } else {
        return { 
          success: false, 
          error: uploadResult?.error || '文件上传失败'
        };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * 尝试自动重连（无限重试，使用指数退避 + 抖动）
   * 
   * 重连策略：
   * - 指数退避：2s → 4s → 8s → 16s → 32s → 60s（最大）
   * - 随机抖动：±25% 的随机偏移，避免多客户端同时重连
   * - 无限重试：持续尝试直到连接成功或手动停止
   * - 认证失败保护：认证失败后不自动重连，需要用户检查密钥
   */
  attemptReconnect() {
    // 如果已经在重连或未启用自动连接，则返回
    if (this.isReconnecting || !this.autoConnect) {
      return;
    }
    
    // 如果认证失败，不自动重连（需要用户检查密钥）
    if (this.authState === 'failed') {
      console.log('认证失败状态，跳过自动重连。请检查认证密钥配置。');
      // 广播状态更新，让用户知道需要检查认证
      this.broadcastStatusUpdate();
      return;
    }
    
    this.isReconnecting = true;
    this.reconnectAttempts++;
    
    // 计算延迟时间（指数退避，最大60秒）
    // 2s → 4s → 8s → 16s → 32s → 60s（之后保持60s）
    const baseDelay = 2000; // 2秒
    const maxDelay = 60000; // 60秒
    const exponentialDelay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempts - 1), maxDelay);
    
    // 添加 ±25% 的随机抖动，避免多客户端同时重连（thundering herd 问题）
    const jitterFactor = 0.25;
    const jitter = exponentialDelay * (Math.random() * jitterFactor * 2 - jitterFactor);
    const delay = Math.round(exponentialDelay + jitter);
    
    console.log(`准备在第 ${this.reconnectAttempts} 次尝试重连，延迟 ${delay}ms（基础: ${exponentialDelay}ms, 抖动: ${Math.round(jitter)}ms）...`);
    
    // 设置重连定时器
    this.reconnectTimer = setTimeout(() => {
      if (this.autoConnect && !this.isConnected) {
        console.log(`正在尝试第 ${this.reconnectAttempts} 次重连...`);
        this.isReconnecting = false;
        this.connect();
      } else {
        this.isReconnecting = false;
      }
    }, delay);
  }

  /**
   * 重置重连计数器
   * 在成功连接后调用，为下次断开做准备
   */
  resetReconnectCounter() {
    this.reconnectAttempts = 0;
    this.wsConsecutiveFailures = 0;
    console.log('[Reconnect] 重连计数器已重置');
  }

  /**
   * 停止自动重连
   */
  stopAutoReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.isReconnecting = false;
    console.log('已停止自动重连');
  }
  
  /**
   * 检查是否应该降级到 SSE
   * @returns {boolean}
   */
  shouldFallbackToSSE() {
    // 如果 SSE 客户端不可用或已禁用，不降级
    if (!this.sseClient) {
      return false;
    }
    
    // 如果已经在 SSE 模式，不需要再降级
    if (this.connectionMode === 'sse') {
      return false;
    }
    
    // 连续失败次数达到阈值
    const threshold = this.sseFallbackThreshold || 5;
    return (this.wsConsecutiveFailures || 0) >= threshold;
  }
  
  /**
   * 降级到 SSE 模式
   */
  fallbackToSSE() {
    console.log('[BrowserControl] WebSocket 连续失败，降级到 SSE 模式');
    
    // 停止 WebSocket 重连
    this.stopAutoReconnect();
    
    // 切换到 SSE 模式
    this.connectionMode = 'sse';
    
    // 连接 SSE
    if (this.sseClient) {
      this.sseClient.connect();
    }
    
    // 启动健康检查（如果还没启动）
    if (this.healthChecker && !this.healthChecker.checkTimer) {
      this.healthChecker.start();
    }
    
    // 广播状态更新
    this.broadcastStatusUpdate();
    
    // 定期尝试恢复 WebSocket 连接
    this.scheduleWSRecovery();
  }
  
  /**
   * 安排 WebSocket 恢复尝试
   */
  scheduleWSRecovery() {
    // 每 60 秒尝试恢复 WebSocket
    const recoveryInterval = 60000;
    
    if (this.wsRecoveryTimer) {
      clearInterval(this.wsRecoveryTimer);
    }
    
    this.wsRecoveryTimer = setInterval(() => {
      if (this.connectionMode === 'sse' && !this.isConnected) {
        console.log('[BrowserControl] 尝试恢复 WebSocket 连接...');
        this.wsConsecutiveFailures = 0; // 重置失败计数
        this.connectionMode = 'websocket';
        this.connect();
      } else if (this.isConnected && this.connectionMode === 'websocket') {
        // WebSocket 已恢复，停止恢复尝试
        clearInterval(this.wsRecoveryTimer);
        this.wsRecoveryTimer = null;
      }
    }, recoveryInterval);
  }
  
  /**
   * 停止 SSE 降级模式，恢复 WebSocket
   */
  stopSSEFallback() {
    if (this.wsRecoveryTimer) {
      clearInterval(this.wsRecoveryTimer);
      this.wsRecoveryTimer = null;
    }
    
    if (this.sseClient) {
      this.sseClient.disconnect();
    }
    
    this.connectionMode = 'websocket';
    this.wsConsecutiveFailures = 0;
    
    console.log('[BrowserControl] 已停止 SSE 降级模式');
  }

  /**
   * 使用新设置重新连接
   */
  async reconnectWithNewSettings() {
    try {
      console.log('正在使用新设置重新连接...');
      
      // 停止当前的重连尝试
      this.stopAutoReconnect();
      
      // 关闭现有连接
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
      
      this.isConnected = false;
      this.reconnectAttempts = 0;
      
      // 重新加载设置
      await this.loadSettings();
      
      // 重新连接（不受自动连接设置影响，这是手动触发）
      this.connect();
      
    } catch (error) {
      console.error('重新连接时出错:', error);
    }
  }

  /**
   * 开始标签页数据同步
   */
  startTabDataSync() {
    // 立即发送一次
    this.sendTabsData();
    
    // 每5秒发送一次标签页数据
    setInterval(() => {
      if (this.isConnected) {
        this.sendTabsData();
      }
    }, 5000);
  }

  /**
   * 发送标签页数据
   */
  async sendTabsData() {
    try {
      if (!this.isConnected) return;
      
      const tabs = await browser.tabs.query({});
      const activeTab = await browser.tabs.query({ active: true, currentWindow: true });
      
      const tabsData = tabs.map(tab => ({
        id: tab.id.toString(),
        url: tab.url || '',
        title: tab.title || '',
        is_active: activeTab.length > 0 && activeTab[0].id === tab.id,
        window_id: tab.windowId.toString(),
        index_in_window: tab.index,
        favicon_url: tab.favIconUrl || null,
        status: tab.status || 'complete'
      }));
      
      this.sendMessage({
        type: 'data',
        payload: {
          tabs: tabsData,
          active_tab_id: activeTab.length > 0 ? activeTab[0].id.toString() : null
        },
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error('发送标签页数据时出错:', error);
    }
  }
}

// 初始化扩展
const browserControl = new BrowserControl();

// 导出供其他脚本使用
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BrowserControl;
}
