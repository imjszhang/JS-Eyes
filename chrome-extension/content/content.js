/**
 * Browser Control Extension - Content Script (Chrome)
 * 
 * 在网页中运行，负责获取页面信息和执行页面操作
 * 
 * 安全特性：
 * - 实现扩展中转通信模式，所有来自注入脚本的请求都必须经过此脚本转发
 * - postMessage 来源验证
 * - 命令白名单验证
 * - 请求频率限制
 */

class ContentScript {
  constructor() {
    this.isInitialized = false;
    this.pageInfo = null;
    
    // 安全相关：频率限制
    this.requestCount = 0;
    this.maxRequestsPerSecond = 10;
    this.isBlocked = false;
    this.blockDuration = 5000; // 超限后阻止5秒
    
    // 允许的操作白名单
    this.allowedActions = [
      'get_tabs', 'get_html', 'open_url', 'close_tab',
      'execute_script', 'get_cookies', 'get_cookies_by_domain', 'inject_css',
      'get_page_info', 'upload_file_to_tab'
    ];
    
    // 启动频率限制重置定时器
    this.requestResetInterval = setInterval(() => {
      this.requestCount = 0;
    }, 1000);
    
    this.init();
  }

  /**
   * 初始化content script
   */
  init() {
    if (this.isInitialized) return;
    
    console.log('Content Script 正在初始化...');
    
    // 等待DOM加载完成
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        this.setup();
      });
    } else {
      this.setup();
    }
    
    this.isInitialized = true;
  }

  /**
   * 设置content script
   */
  setup() {
    // 收集页面基本信息
    this.collectPageInfo();
    
    // 设置消息监听（来自 Background Script）
    this.setupMessageListeners();
    
    // 设置页面消息监听（来自注入脚本的 postMessage）
    this.setupPageMessageListener();
    
    // 监听页面变化
    this.setupPageObserver();
    
    console.log('Content Script 初始化完成（安全中转模式已启用）');
  }

  /**
   * 收集页面信息
   */
  collectPageInfo() {
    this.pageInfo = {
      url: window.location.href,
      title: document.title,
      domain: window.location.hostname,
      protocol: window.location.protocol,
      pathname: window.location.pathname,
      search: window.location.search,
      hash: window.location.hash,
      
      // 页面元数据
      meta: this.getMetaData(),
      
      // 页面统计
      stats: {
        images: document.images.length,
        links: document.links.length,
        forms: document.forms.length,
        scripts: document.scripts.length,
        stylesheets: document.styleSheets.length
      },
      
      // 页面状态
      readyState: document.readyState,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 获取页面元数据
   */
  getMetaData() {
    const meta = {};
    const metaTags = document.querySelectorAll('meta');
    
    metaTags.forEach(tag => {
      const name = tag.getAttribute('name') || tag.getAttribute('property') || tag.getAttribute('http-equiv');
      const content = tag.getAttribute('content');
      
      if (name && content) {
        meta[name] = content;
      }
    });
    
    return meta;
  }

  /**
   * 获取页面完整HTML
   */
  getFullHTML() {
    return document.documentElement.outerHTML;
  }

  /**
   * 获取页面文本内容
   */
  getTextContent() {
    return document.body ? document.body.innerText : '';
  }

  /**
   * 获取页面中的所有链接
   */
  getAllLinks() {
    const links = [];
    const linkElements = document.querySelectorAll('a[href]');
    
    linkElements.forEach(link => {
      links.push({
        href: link.href,
        text: link.textContent.trim(),
        title: link.title || null,
        target: link.target || null
      });
    });
    
    return links;
  }

  /**
   * 获取页面中的所有图片
   */
  getAllImages() {
    const images = [];
    const imgElements = document.querySelectorAll('img');
    
    imgElements.forEach(img => {
      images.push({
        src: img.src,
        alt: img.alt || null,
        title: img.title || null,
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height
      });
    });
    
    return images;
  }

  /**
   * 获取页面中的所有表单
   */
  getAllForms() {
    const forms = [];
    const formElements = document.querySelectorAll('form');
    
    formElements.forEach((form, index) => {
      const fields = [];
      const inputs = form.querySelectorAll('input, select, textarea');
      
      inputs.forEach(input => {
        fields.push({
          name: input.name || null,
          type: input.type || 'text',
          value: input.value || null,
          placeholder: input.placeholder || null,
          required: input.required || false
        });
      });
      
      forms.push({
        index: index,
        action: form.action || null,
        method: form.method || 'get',
        fields: fields
      });
    });
    
    return forms;
  }

  /**
   * 执行自定义JavaScript代码
   */
  executeCustomScript(code) {
    try {
      // 创建一个函数来执行代码，避免污染全局作用域
      const func = new Function('document', 'window', 'console', code);
      return func(document, window, console);
    } catch (error) {
      console.error('执行自定义脚本时出错:', error);
      throw error;
    }
  }

  /**
   * 注入CSS样式
   */
  injectCSS(css) {
    try {
      const style = document.createElement('style');
      style.type = 'text/css';
      style.textContent = css;
      document.head.appendChild(style);
      return true;
    } catch (error) {
      console.error('注入CSS时出错:', error);
      throw error;
    }
  }

  /**
   * 查找页面元素
   */
  findElements(selector) {
    try {
      const elements = document.querySelectorAll(selector);
      const results = [];
      
      elements.forEach((element, index) => {
        results.push({
          index: index,
          tagName: element.tagName.toLowerCase(),
          id: element.id || null,
          className: element.className || null,
          textContent: element.textContent.trim().substring(0, 200), // 限制长度
          attributes: this.getElementAttributes(element)
        });
      });
      
      return results;
    } catch (error) {
      console.error('查找页面元素时出错:', error);
      throw error;
    }
  }

  /**
   * 获取元素属性
   */
  getElementAttributes(element) {
    const attributes = {};
    
    if (element.attributes) {
      for (let i = 0; i < element.attributes.length; i++) {
        const attr = element.attributes[i];
        attributes[attr.name] = attr.value;
      }
    }
    
    return attributes;
  }

  /**
   * 模拟点击元素
   */
  clickElement(selector) {
    try {
      const element = document.querySelector(selector);
      if (element) {
        element.click();
        return true;
      } else {
        throw new Error(`未找到元素: ${selector}`);
      }
    } catch (error) {
      console.error('点击元素时出错:', error);
      throw error;
    }
  }

  /**
   * 填写表单字段
   */
  fillFormField(selector, value) {
    try {
      const element = document.querySelector(selector);
      if (element) {
        element.value = value;
        
        // 触发change事件
        const event = new Event('change', { bubbles: true });
        element.dispatchEvent(event);
        
        return true;
      } else {
        throw new Error(`未找到表单字段: ${selector}`);
      }
    } catch (error) {
      console.error('填写表单字段时出错:', error);
      throw error;
    }
  }

  /**
   * 设置消息监听（来自 Background Script）
   */
  setupMessageListeners() {
    // 监听来自background script的消息
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      try {
        switch (message.type) {
          case 'get_page_info':
            this.collectPageInfo();
            sendResponse({ success: true, data: this.pageInfo });
            break;
            
          case 'get_full_html':
            sendResponse({ success: true, data: this.getFullHTML() });
            break;
            
          case 'get_text_content':
            sendResponse({ success: true, data: this.getTextContent() });
            break;
            
          case 'get_all_links':
            sendResponse({ success: true, data: this.getAllLinks() });
            break;
            
          case 'get_all_images':
            sendResponse({ success: true, data: this.getAllImages() });
            break;
            
          case 'get_all_forms':
            sendResponse({ success: true, data: this.getAllForms() });
            break;
            
          case 'execute_script':
            const result = this.executeCustomScript(message.code);
            sendResponse({ success: true, data: result });
            break;
            
          case 'inject_css':
            this.injectCSS(message.css);
            sendResponse({ success: true });
            break;
            
          case 'find_elements':
            const elements = this.findElements(message.selector);
            sendResponse({ success: true, data: elements });
            break;
            
          case 'click_element':
            this.clickElement(message.selector);
            sendResponse({ success: true });
            break;
            
          case 'fill_form_field':
            this.fillFormField(message.selector, message.value);
            sendResponse({ success: true });
            break;
            
          default:
            sendResponse({ success: false, error: '未知消息类型' });
            break;
        }
      } catch (error) {
        console.error('处理消息时出错:', error);
        sendResponse({ success: false, error: error.message });
      }
      
      return true; // 保持消息通道开放
    });
  }

  /**
   * 设置页面消息监听（来自注入脚本的 postMessage）
   * 这是安全中转通信的核心功能
   */
  setupPageMessageListener() {
    window.addEventListener('message', async (event) => {
      // 安全验证 1：只处理来自当前窗口的消息（防止 iframe 伪造）
      if (event.source !== window) {
        return;
      }
      
      // 类型验证：只处理 EXTENSION_REQUEST 类型的消息
      if (!event.data || event.data.type !== 'EXTENSION_REQUEST') {
        return;
      }
      
      console.log('[Content Script] 收到页面请求:', event.data.action);
      
      // 处理请求并转发给 Background Script
      await this.handlePageRequest(event.data);
    });
    
    console.log('[Content Script] 页面消息监听器已设置');
  }

  /**
   * 检查请求频率限制
   * @returns {boolean} 如果允许请求返回 true，否则返回 false
   */
  checkRateLimit() {
    // 如果正在被阻止
    if (this.isBlocked) {
      console.warn('[Content Script] 请求被阻止：超过频率限制');
      return false;
    }
    
    this.requestCount++;
    
    // 检查是否超过限制
    if (this.requestCount > this.maxRequestsPerSecond) {
      console.warn(`[Content Script] 请求频率过高 (${this.requestCount}/${this.maxRequestsPerSecond})，暂时阻止请求`);
      this.isBlocked = true;
      
      // 设置解除阻止的定时器
      setTimeout(() => {
        this.isBlocked = false;
        this.requestCount = 0;
        console.log('[Content Script] 请求阻止已解除');
      }, this.blockDuration);
      
      return false;
    }
    
    return true;
  }

  /**
   * 处理来自页面的请求
   * @param {Object} request 请求对象
   */
  async handlePageRequest(request) {
    const { action, payload, requestId } = request;
    
    // 安全验证 2：检查频率限制
    if (!this.checkRateLimit()) {
      this.sendResponseToPage(requestId, false, null, '请求频率过高，请稍后再试');
      return;
    }
    
    // 安全验证 3：命令白名单验证
    if (!this.allowedActions.includes(action)) {
      console.warn(`[Content Script] 拒绝不允许的操作: ${action}`);
      this.sendResponseToPage(requestId, false, null, `不允许的操作: ${action}`);
      return;
    }
    
    try {
      // 转发请求给 Background Script
      const response = await chrome.runtime.sendMessage({
        type: 'CONTENT_SCRIPT_REQUEST',
        action: action,
        payload: payload || {},
        requestId: requestId,
        sourceUrl: window.location.href,
        sourceOrigin: window.location.origin
      });
      
      // 将响应转发回页面
      if (response) {
        this.sendResponseToPage(requestId, response.success, response.data, response.error);
      } else {
        this.sendResponseToPage(requestId, false, null, 'Background Script 无响应');
      }
      
    } catch (error) {
      console.error('[Content Script] 转发请求时出错:', error);
      this.sendResponseToPage(requestId, false, null, error.message);
    }
  }

  /**
   * 将响应发送回页面
   * @param {string} requestId 请求ID
   * @param {boolean} success 是否成功
   * @param {*} data 响应数据
   * @param {string} error 错误信息
   */
  sendResponseToPage(requestId, success, data, error) {
    window.postMessage({
      type: 'EXTENSION_RESPONSE',
      requestId: requestId,
      success: success,
      data: data,
      error: error || null,
      timestamp: new Date().toISOString()
    }, '*');
    
    console.log(`[Content Script] 响应已发送: requestId=${requestId}, success=${success}`);
  }

  /**
   * 设置页面观察器
   */
  setupPageObserver() {
    // 监听URL变化
    let currentUrl = window.location.href;
    
    const checkUrlChange = () => {
      if (window.location.href !== currentUrl) {
        currentUrl = window.location.href;
        console.log('页面URL发生变化:', currentUrl);
        
        // 重新收集页面信息
        setTimeout(() => {
          this.collectPageInfo();
        }, 1000);
      }
    };
    
    // 监听pushState和replaceState
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    
    history.pushState = function(...args) {
      originalPushState.apply(history, args);
      setTimeout(checkUrlChange, 100);
    };
    
    history.replaceState = function(...args) {
      originalReplaceState.apply(history, args);
      setTimeout(checkUrlChange, 100);
    };
    
    // 监听popstate事件
    window.addEventListener('popstate', checkUrlChange);
    
    // 监听DOM变化（可选，可能影响性能）
    if (typeof MutationObserver !== 'undefined') {
      const observer = new MutationObserver((mutations) => {
        // 只在重要变化时更新页面信息
        let shouldUpdate = false;
        
        mutations.forEach((mutation) => {
          if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
            // 检查是否有重要元素被添加
            mutation.addedNodes.forEach((node) => {
              if (node.nodeType === Node.ELEMENT_NODE) {
                const tagName = node.tagName ? node.tagName.toLowerCase() : '';
                if (['form', 'iframe', 'script'].includes(tagName)) {
                  shouldUpdate = true;
                }
              }
            });
          }
        });
        
        if (shouldUpdate) {
          setTimeout(() => {
            this.collectPageInfo();
          }, 500);
        }
      });
      
      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
    }
  }
}

// 初始化content script
const contentScript = new ContentScript();

// 导出供其他脚本使用
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ContentScript;
}
