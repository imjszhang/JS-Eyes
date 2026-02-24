/**
 * Firefox 扩展配置文件
 * 
 * 由于浏览器扩展无法直接访问 Node.js 环境变量，
 * 这个配置文件提供了默认的服务器地址配置
 * 
 * 生成时间: 2025-09-19T00:40:37+08:00
 * 更新时间: 2026-01-26 (添加安全配置)
 */

// 默认配置
const DEFAULT_CONFIG = {
  // 服务器入口地址（唯一需要配置的地址）
  // 扩展会自动通过能力探测获取 WebSocket 地址和 HTTP API 地址
  // 支持 http:// 或 ws:// 协议
  SERVER_URL: 'http://localhost:18080',

  // 能力探测配置
  DISCOVERY: {
    enabled: true,
    configEndpoint: '/api/browser/config',
    timeout: 5000,
    fallbackWsFromHttp: true
  },

  // WebSocket 服务器地址列表（可选 fallback，探测失败时使用）
  WEBSOCKET_SERVER_URLS: [
    'ws://localhost:18080',
    'ws://example.local:18080',
    'wss://example.local:18080',
    'ws://ws.example.local',
    'wss://ws.example.local'
  ],
  
  // 连接重试配置
  CONNECTION_RETRY: {
    maxRetries: 5,
    retryDelay: 2000, // 2秒
    backoffMultiplier: 1.5
  },
  
  // 健康检查配置
  HEALTH_CHECK: {
    enabled: true,
    interval: 30000,              // 检查间隔（毫秒）
    endpoint: '/api/browser/health',
    timeout: 5000,                // 请求超时（毫秒）
    circuitBreaker: {
      criticalCooldown: 60000,    // critical 状态冷却期（毫秒）
      warningThrottle: 0.5,       // warning 状态降速比例
      maxConsecutiveFailures: 3   // 连续失败次数阈值
    }
  },
  
  // SSE 降级配置
  SSE: {
    enabled: true,
    endpoint: '/api/browser/events',
    reconnectInterval: 5000,      // 重连间隔（毫秒）
    maxReconnectAttempts: 10,     // 最大重连次数
    fallbackAfterWsFailures: 5    // WebSocket 失败多少次后降级到 SSE
  },
  
  // 安全配置（用于扩展中转通信模式）
  SECURITY: {
    // 允许的操作白名单
    // 只有在此列表中的操作才会被 Content Script 转发给 Background Script
    allowedActions: [
      'get_tabs',           // 获取标签页列表
      'get_html',           // 获取页面 HTML
      'open_url',           // 打开 URL
      'close_tab',          // 关闭标签页
      'execute_script',     // 执行脚本（高风险）
      'get_cookies',        // 获取 Cookies（高风险）
      'get_cookies_by_domain', // 按域名获取 Cookies（高风险）
      'inject_css',         // 注入 CSS
      'get_page_info',      // 获取页面信息
      'upload_file_to_tab', // 上传文件到标签页
      'subscribe_events',   // 订阅事件
      'unsubscribe_events'  // 取消订阅事件
    ],
    
    // 高风险操作列表（需要额外验证）
    // 这些操作在执行前会进行额外的安全检查
    sensitiveActions: [
      'execute_script',     // 可执行任意代码
      'get_cookies',        // 可获取敏感的认证信息
      'get_cookies_by_domain' // 可获取敏感的认证信息
    ],
    
    // 频率限制配置
    rateLimit: {
      maxRequestsPerSecond: 10,   // 每秒最大请求数
      blockDuration: 5000         // 超限后阻止时间（毫秒）
    },
    
    // 请求超时时间（毫秒）
    // 与服务器端保持一致（服务器默认 60 秒）
    requestTimeout: 60000,
    
    // 认证配置（与服务器安全握手）
    // 密钥从 browser.storage.local 读取，通过 Popup 界面设置
    // 不要在此硬编码密钥！
    auth: {
      // 密钥存储键名
      storageKey: 'auth_secret_key',
      
      // 认证超时时间（毫秒）
      // 与服务器端保持一致（服务器默认 30 秒）
      authTimeout: 30000,
      
      // 会话有效期提前刷新时间（秒）
      // 在会话过期前这么多秒开始尝试重新认证
      sessionRefreshBefore: 300
    }
  }
};

// 导出配置
if (typeof module !== 'undefined' && module.exports) {
  // Node.js 环境
  module.exports = DEFAULT_CONFIG;
} else {
  // 浏览器环境
  window.EXTENSION_CONFIG = DEFAULT_CONFIG;
}