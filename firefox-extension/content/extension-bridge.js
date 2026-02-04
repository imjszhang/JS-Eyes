/**
 * ExtensionBridge - 用户注入脚本辅助库
 * 
 * 提供便捷的 API 与浏览器扩展进行安全通信
 * 所有通信都通过 postMessage 与 Content Script 中转，
 * 然后由 Content Script 转发给 Background Script 处理
 * 
 * 使用方法：
 * 1. 在页面中注入此脚本
 * 2. 使用 ExtensionBridge 实例调用各种 API
 * 
 * 示例：
 *   const tabs = await ExtensionBridge.getTabs();
 *   const html = await ExtensionBridge.getHtml(tabId);
 *   await ExtensionBridge.executeScript(tabId, 'console.log("Hello")');
 */

(function(window) {
  'use strict';

  /**
   * ExtensionBridge 类
   * 封装与扩展通信的所有逻辑
   */
  class ExtensionBridgeClass {
    constructor() {
      // 待处理的请求映射
      this.pendingRequests = new Map();
      
      // 请求超时时间（毫秒）
      this.requestTimeout = 30000;
      
      // 是否已初始化
      this.isInitialized = false;
      
      // 扩展是否可用
      this.isExtensionAvailable = false;
      
      // 初始化
      this.init();
    }

    /**
     * 初始化 ExtensionBridge
     */
    init() {
      if (this.isInitialized) {
        return;
      }
      
      // 设置响应监听器
      this.setupResponseListener();
      
      // 检测扩展是否可用
      this.checkExtensionAvailability();
      
      this.isInitialized = true;
      
      console.log('[ExtensionBridge] 初始化完成');
    }

    /**
     * 生成唯一的请求ID
     * @returns {string} 请求ID
     */
    generateRequestId() {
      return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * 设置响应监听器
     * 监听来自 Content Script 的响应
     */
    setupResponseListener() {
      window.addEventListener('message', (event) => {
        // 只处理来自当前窗口的消息
        if (event.source !== window) {
          return;
        }
        
        // 只处理扩展响应类型的消息
        if (!event.data || event.data.type !== 'EXTENSION_RESPONSE') {
          return;
        }
        
        const { requestId, success, data, error } = event.data;
        
        // 查找对应的待处理请求
        const pending = this.pendingRequests.get(requestId);
        
        if (pending) {
          // 清除超时定时器
          clearTimeout(pending.timeout);
          
          // 解析或拒绝 Promise
          if (success) {
            pending.resolve(data);
          } else {
            pending.reject(new Error(error || '请求失败'));
          }
          
          // 从待处理列表中移除
          this.pendingRequests.delete(requestId);
        }
      });
    }

    /**
     * 检测扩展是否可用
     * 通过发送一个测试请求来检测
     */
    async checkExtensionAvailability() {
      try {
        // 尝试获取标签页列表作为测试
        await this.request('get_tabs', {}, 5000);
        this.isExtensionAvailable = true;
        console.log('[ExtensionBridge] 扩展可用');
      } catch (error) {
        this.isExtensionAvailable = false;
        console.warn('[ExtensionBridge] 扩展不可用或未连接:', error.message);
      }
    }

    /**
     * 发送请求到扩展
     * 
     * @param {string} action 操作名称
     * @param {Object} payload 请求载荷
     * @param {number} timeout 超时时间（毫秒），默认使用 this.requestTimeout
     * @returns {Promise<*>} 响应数据
     */
    async request(action, payload = {}, timeout = null) {
      return new Promise((resolve, reject) => {
        const requestId = this.generateRequestId();
        const timeoutMs = timeout || this.requestTimeout;
        
        // 设置超时定时器
        const timeoutId = setTimeout(() => {
          this.pendingRequests.delete(requestId);
          reject(new Error(`请求超时 (${timeoutMs}ms): ${action}`));
        }, timeoutMs);
        
        // 保存待处理请求
        this.pendingRequests.set(requestId, {
          resolve,
          reject,
          timeout: timeoutId,
          action,
          timestamp: Date.now()
        });
        
        // 发送请求到 Content Script
        window.postMessage({
          type: 'EXTENSION_REQUEST',
          action: action,
          payload: payload,
          requestId: requestId
        }, '*');
      });
    }

    // ============== 便捷 API ==============

    /**
     * 获取所有标签页
     * @returns {Promise<Object>} 标签页列表和当前活动标签页ID
     */
    async getTabs() {
      return this.request('get_tabs');
    }

    /**
     * 获取指定标签页的 HTML 内容
     * @param {number} tabId 标签页ID
     * @returns {Promise<Object>} 包含 html 属性的对象
     */
    async getHtml(tabId) {
      if (!tabId) {
        throw new Error('tabId 是必需的');
      }
      return this.request('get_html', { tabId });
    }

    /**
     * 在指定标签页中执行脚本
     * @param {number} tabId 标签页ID
     * @param {string} code 要执行的 JavaScript 代码
     * @returns {Promise<Object>} 执行结果
     */
    async executeScript(tabId, code) {
      if (!code) {
        throw new Error('code 是必需的');
      }
      return this.request('execute_script', { tabId, code });
    }

    /**
     * 获取指定标签页的 Cookies
     * @param {number} tabId 标签页ID
     * @returns {Promise<Object>} 包含 cookies 数组的对象
     */
    async getCookies(tabId) {
      if (!tabId) {
        throw new Error('tabId 是必需的');
      }
      return this.request('get_cookies', { tabId });
    }

    /**
     * 按域名获取 Cookies（不需要 tabId）
     * @param {string} domain 域名，如 "xiaohongshu.com"
     * @param {boolean} includeSubdomains 是否包含子域名，默认 true
     * @returns {Promise<Object>} 包含 cookies 数组的对象
     */
    async getCookiesByDomain(domain, includeSubdomains = true) {
      if (!domain) {
        throw new Error('domain 是必需的');
      }
      return this.request('get_cookies_by_domain', { domain, includeSubdomains });
    }

    /**
     * 打开 URL
     * @param {string} url 要打开的 URL
     * @param {number} tabId 可选，在指定标签页中打开
     * @param {number} windowId 可选，在指定窗口中打开
     * @returns {Promise<Object>} 包含新标签页ID的对象
     */
    async openUrl(url, tabId = null, windowId = null) {
      if (!url) {
        throw new Error('url 是必需的');
      }
      const payload = { url };
      if (tabId) payload.tabId = tabId;
      if (windowId) payload.windowId = windowId;
      return this.request('open_url', payload);
    }

    /**
     * 关闭标签页
     * @param {number} tabId 要关闭的标签页ID
     * @returns {Promise<Object>} 关闭结果
     */
    async closeTab(tabId) {
      if (!tabId) {
        throw new Error('tabId 是必需的');
      }
      return this.request('close_tab', { tabId });
    }

    /**
     * 注入 CSS 到指定标签页
     * @param {number} tabId 标签页ID
     * @param {string} css CSS 代码
     * @returns {Promise<Object>} 注入结果
     */
    async injectCss(tabId, css) {
      if (!tabId || !css) {
        throw new Error('tabId 和 css 都是必需的');
      }
      return this.request('inject_css', { tabId, css });
    }

    /**
     * 获取页面信息
     * @param {number} tabId 可选，标签页ID
     * @returns {Promise<Object>} 页面信息
     */
    async getPageInfo(tabId = null) {
      const payload = {};
      if (tabId) payload.tabId = tabId;
      return this.request('get_page_info', payload);
    }

    /**
     * 上传文件到指定标签页的文件输入元素
     * @param {number} tabId 标签页ID
     * @param {Array} files 文件数组
     * @param {string} targetSelector 目标文件输入元素的选择器
     * @returns {Promise<Object>} 上传结果
     */
    async uploadFile(tabId, files, targetSelector = 'input[type="file"]') {
      if (!tabId || !files) {
        throw new Error('tabId 和 files 都是必需的');
      }
      return this.request('upload_file_to_tab', { tabId, files, targetSelector });
    }

    // ============== 工具方法 ==============

    /**
     * 检查扩展是否可用
     * @returns {boolean} 扩展是否可用
     */
    isAvailable() {
      return this.isExtensionAvailable;
    }

    /**
     * 获取待处理请求数量
     * @returns {number} 待处理请求数量
     */
    getPendingRequestCount() {
      return this.pendingRequests.size;
    }

    /**
     * 取消所有待处理请求
     */
    cancelAllRequests() {
      for (const [requestId, pending] of this.pendingRequests) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('请求已取消'));
      }
      this.pendingRequests.clear();
      console.log('[ExtensionBridge] 已取消所有待处理请求');
    }

    /**
     * 设置请求超时时间
     * @param {number} timeout 超时时间（毫秒）
     */
    setRequestTimeout(timeout) {
      if (typeof timeout === 'number' && timeout > 0) {
        this.requestTimeout = timeout;
        console.log(`[ExtensionBridge] 请求超时时间已设置为 ${timeout}ms`);
      }
    }
  }

  // 创建全局单例实例
  const ExtensionBridge = new ExtensionBridgeClass();

  // 暴露到全局
  window.ExtensionBridge = ExtensionBridge;

  // 同时支持 ES Module 风格（如果环境支持）
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ExtensionBridge;
  }

  console.log('[ExtensionBridge] 辅助库已加载，可通过 window.ExtensionBridge 使用');

})(typeof window !== 'undefined' ? window : this);
