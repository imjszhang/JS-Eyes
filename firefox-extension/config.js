/**
 * Firefox 扩展配置文件
 * 
 * 由于浏览器扩展无法直接访问 Node.js 环境变量，
 * 这个配置文件提供了默认的服务器地址配置
 * 
 * 生成时间: 2025-09-19T00:40:37+08:00
 */

// 默认配置
const DEFAULT_CONFIG = {
  // WebSocket 服务器地址（用于与 browserControlServer 通信）
  // 支持多个地址，扩展会自动尝试连接
  WEBSOCKET_SERVER_URLS: [
    // 本地开发环境
    'ws://localhost:8080',
    
    // Docker本地部署 (使用默认域名)
    'ws://example.local:8080',
    'wss://example.local:8080',
    
    // Docker部署 (通过WebSocket子域名)
    'ws://ws.example.local',
    'wss://ws.example.local',
    
    // Docker部署 (直接通过主域名的8080端口)
    'ws://example.local:8080',
    'wss://example.local:8080',
    
    // 生产环境示例 (需要根据实际域名调整)
    // 'wss://ws.yourdomain.com',
    // 'wss://yourdomain.com:8080'
  ],
  
  // 主要WebSocket服务器地址（向后兼容）
  WEBSOCKET_SERVER_URL: 'ws://localhost:8080',
  
  // HTTP 服务器地址（备用）
  HTTP_SERVER_URL: 'http://localhost:3333',
  
  // 连接重试配置
  CONNECTION_RETRY: {
    maxRetries: 5,
    retryDelay: 2000, // 2秒
    backoffMultiplier: 1.5
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