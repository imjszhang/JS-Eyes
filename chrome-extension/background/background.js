/**
 * Kaichi Browser Control Extension - Background Script (Chrome Manifest V3)
 * 
 * 负责与browserControlServer的WebSocket通信
 * 处理标签页管理、内容获取、脚本执行等功能
 */

// 内联配置（因为 Service Worker 不能使用 importScripts）
const EXTENSION_CONFIG = {
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
  WEBSOCKET_SERVER_URL: 'ws://localhost:8080',
  HTTP_SERVER_URL: 'http://localhost:3333',
  CONNECTION_RETRY: {
    maxRetries: 5,
    retryDelay: 2000,
    backoffMultiplier: 1.5
  }
};

class KaichiBrowserControl {
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
    
    // 初始化
    this.init();
  }

  /**
   * 初始化扩展
   */
  async init() {
    console.log('Kaichi Browser Control Extension 正在初始化...');
    
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
      const result = await chrome.storage.local.get(['serverUrl', 'autoConnect']);
      
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
      
    } catch (error) {
      console.error('加载设置时出错:', error);
      // 使用默认设置
      this.serverUrl = this.defaultServerUrls[0];
      this.autoConnect = true;
    }
  }

  /**
   * 连接到WebSocket服务器
   */
  connect() {
    try {
      console.log(`正在连接到 ${this.serverUrl}...`);
      this.ws = new WebSocket(this.serverUrl);
      
      this.ws.onopen = () => {
        console.log('WebSocket连接已建立');
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.isReconnecting = false;
        
        // 清除重连定时器
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        
        // 发送初始化消息
        this.sendMessage({
          type: 'init',
          timestamp: new Date().toISOString(),
          userAgent: navigator.userAgent
        });
        
        // 立即发送一次标签页数据
        this.sendTabsData();
      };
      
      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };
      
      this.ws.onclose = (event) => {
        console.log('WebSocket连接已关闭:', event.code, event.reason);
        this.isConnected = false;
        
        // 如果启用自动连接，则尝试重连
        if (this.autoConnect && !this.isReconnecting) {
          this.attemptReconnect();
        }
      };
      
      this.ws.onerror = (error) => {
        console.error('WebSocket错误:', error);
        this.isConnected = false;
        
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
   * 发送消息到服务器
   */
  sendMessage(message) {
    if (this.isConnected && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return true;
    } else {
      console.warn('WebSocket未连接，无法发送消息:', message);
      return false;
    }
  }

  /**
   * 处理来自服务器的消息
   */
  async handleMessage(data) {
    try {
      const message = JSON.parse(data);
      console.log('收到服务器消息:', message.type, message);
      
      switch (message.type) {
        case 'open_url':
          await this.handleOpenUrl(message);
          break;
          
        case 'close_tab':
          await this.handleCloseTab(message);
          break;
          
        case 'get_html':
          await this.handleGetHtml(message);
          break;
          
        case 'execute_script':
          await this.handleExecuteScript(message);
          break;
          
        case 'inject_css':
          await this.handleInjectCss(message);
          break;
          
        case 'get_cookies':
          await this.handleGetCookies(message);
          break;
          
        case 'upload_file_to_tab':
          await this.handleUploadFileToTab(message);
          break;
          
        default:
          console.warn('未知消息类型:', message.type);
          break;
      }
    } catch (error) {
      console.error('处理服务器消息时出错:', error);
    }
  }

  /**
   * 处理打开URL请求
   */
  async handleOpenUrl(message) {
    try {
      const { url, tabId, windowId, requestId } = message;
      
      let resultTabId;
      
      if (tabId) {
        // 更新现有标签页
        await chrome.tabs.update(parseInt(tabId), { url: url });
        resultTabId = tabId;
      } else {
        // 创建新标签页
        const createProperties = { url: url };
        if (windowId) {
          createProperties.windowId = parseInt(windowId);
        }
        
        const tab = await chrome.tabs.create(createProperties);
        resultTabId = tab.id;
      }
      
      // 等待页面加载完成
      await this.waitForTabLoad(resultTabId);
      
      // 获取cookies
      const cookies = await this.getTabCookies(resultTabId);
      
      // 发送完成响应
      this.sendMessage({
        type: 'open_url_complete',
        tabId: resultTabId,
        url: url,
        cookies: cookies,
        requestId: requestId,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error('处理打开URL请求时出错:', error);
      this.sendMessage({
        type: 'error',
        message: error.message,
        requestId: message.requestId
      });
    }
  }

  /**
   * 处理关闭标签页请求
   */
  async handleCloseTab(message) {
    try {
      const { tabId, requestId } = message;
      
      await chrome.tabs.remove(parseInt(tabId));
      
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
   */
  async handleGetHtml(message) {
    try {
      const { tabId, requestId } = message;
      
      // 通过content script获取HTML
      const results = await chrome.scripting.executeScript({
        target: { tabId: parseInt(tabId) },
        func: () => document.documentElement.outerHTML
      });
      
      const html = results[0].result || '';
      
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
        requestId: message.requestId
      });
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
   */
  async handleExecuteScript(message) {
    try {
      const { tabId, code, requestId } = message;
      
      // Manifest V3 需要使用函数对象，不能直接传递代码字符串
      // 创建一个包装函数来执行代码（支持 Promise 等待）
      const executeCode = async function(scriptCode) {
        try {
          // 使用 eval 执行代码（在页面上下文中）
          const result = eval(scriptCode);
          // 检测返回值是否为 Promise（thenable），如果是则等待
          if (result && typeof result.then === 'function') {
            return await result;
          }
          return result;
        } catch (error) {
          throw new Error('脚本执行错误: ' + error.message);
        }
      };
      
      const results = await chrome.scripting.executeScript({
        target: { tabId: parseInt(tabId) },
        func: executeCode,
        args: [code]
      });
      
      this.sendMessage({
        type: 'execute_script_complete',
        tabId: tabId,
        result: results[0]?.result,
        requestId: requestId,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error('处理执行脚本请求时出错:', error);
      this.sendMessage({
        type: 'error',
        message: error.message,
        requestId: message.requestId
      });
    }
  }

  /**
   * 处理注入CSS请求
   */
  async handleInjectCss(message) {
    try {
      const { tabId, css, requestId } = message;
      
      await chrome.scripting.insertCSS({
        target: { tabId: parseInt(tabId) },
        css: css
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
      
      const tab = await chrome.tabs.get(parseInt(tabId));
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
   * 获取标签页的cookies（增强版 - 获取所有相关域名的cookies，优化错误处理）
   */
  async getTabCookies(tabId, url = null) {
    try {
      if (!url) {
        const tab = await chrome.tabs.get(parseInt(tabId));
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
        const mainDomainCookies = await chrome.cookies.getAll({
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
          const parentDomainCookies = await chrome.cookies.getAll({
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
          const subdomainCookies = await chrome.cookies.getAll({
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
        const urlCookies = await chrome.cookies.getAll({
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
        const storeIds = await chrome.cookies.getAllCookieStores();
        let storeCount = 0;
        for (const store of storeIds) {
          try {
            const storeCookies = await chrome.cookies.getAll({
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
      
      // 转换Base64数据为Blob
      const fileBlobs = [];
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
          
          // 创建Blob
          const blob = new Blob([uint8Array], { type: fileData.type });
          fileBlobs.push({
            blob: blob,
            name: fileData.name,
            size: fileData.size,
            type: fileData.type
          });
          
          console.log(`文件转换成功: ${fileData.name} (${Math.round(fileData.size / 1024)}KB)`);
          
        } catch (error) {
          console.error(`文件转换失败: ${fileData.name}`, error);
          throw new Error(`文件转换失败: ${fileData.name} - ${error.message}`);
        }
      }
      
      // 注入脚本到目标标签页来处理文件上传
      const results = await chrome.scripting.executeScript({
        target: { tabId: parseInt(tabId) },
        func: this.generateFileUploadScript,
        args: [targetSelector || 'input[type="file"]']
      });
      
      const uploadResult = results[0].result;
      
      if (uploadResult && uploadResult.success) {
        console.log(`文件上传成功: tabId=${tabId}, 上传了${fileBlobs.length}个文件`);
        
        // 发送成功响应
        this.sendMessage({
          type: 'upload_file_to_tab_complete',
          tabId: tabId,
          uploadedFiles: fileBlobs.map(file => ({
            name: file.name,
            size: file.size,
            type: file.type,
            lastModified: Date.now()
          })),
          targetSelector: targetSelector,
          message: `成功上传 ${fileBlobs.length} 个文件`,
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
   * 生成文件上传脚本函数（用于 executeScript）
   */
  generateFileUploadScript(targetSelector) {
    try {
      console.log('开始执行文件上传脚本...');
      
      // 查找目标文件输入元素
      let fileInput = document.querySelector(targetSelector);
      
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
          throw new Error('未找到文件输入元素: ' + targetSelector);
        }
      }
      
      console.log('找到文件输入元素:', fileInput);
      
      // 注意：由于安全限制，我们无法直接创建File对象并设置到input.files
      // 但我们可以触发文件输入的点击事件，让用户手动选择文件
      // 或者使用其他方法来设置文件
      
      // 方法1: 尝试触发文件输入事件
      try {
        fileInput.focus();
        fileInput.click();
        
        // 触发change事件
        const changeEvent = new Event('change', { bubbles: true });
        fileInput.dispatchEvent(changeEvent);
        
        // 触发input事件
        const inputEvent = new Event('input', { bubbles: true });
        fileInput.dispatchEvent(inputEvent);
        
        console.log('文件输入事件已触发');
        
      } catch (error) {
        console.warn('触发文件输入事件失败:', error.message);
      }
      
      // 返回成功结果
      return {
        success: true,
        message: '文件上传脚本执行完成，已触发文件输入相关事件',
        targetElement: fileInput.tagName + (fileInput.className ? '.' + fileInput.className : ''),
        targetSelector: targetSelector
      };
      
    } catch (error) {
      console.error('文件上传脚本执行失败:', error);
      return {
        success: false,
        error: error.message
      };
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
          const tab = await chrome.tabs.get(parseInt(tabId));
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
    chrome.tabs.onCreated.addListener((tab) => {
      console.log('标签页创建:', tab.id, tab.url);
      setTimeout(() => this.sendTabsData(), 1000);
    });
    
    // 标签页更新
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.status === 'complete') {
        console.log('标签页加载完成:', tabId, tab.url);
        setTimeout(() => this.sendTabsData(), 500);
      }
    });
    
    // 标签页移除
    chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
      console.log('标签页移除:', tabId);
      setTimeout(() => this.sendTabsData(), 500);
    });
    
    // 标签页激活
    chrome.tabs.onActivated.addListener((activeInfo) => {
      console.log('标签页激活:', activeInfo.tabId);
      setTimeout(() => this.sendTabsData(), 200);
    });
  }

  /**
   * 设置消息监听
   */
  setupMessageListeners() {
    // 监听来自popup的消息
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'get_connection_status') {
        sendResponse({
          isConnected: this.isConnected,
          serverUrl: this.serverUrl,
          reconnectAttempts: this.reconnectAttempts
        });
        return true; // 保持消息通道开放
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
   * 尝试自动重连（无限重试，使用指数退避）
   */
  attemptReconnect() {
    // 如果已经在重连或未启用自动连接，则返回
    if (this.isReconnecting || !this.autoConnect) {
      return;
    }
    
    this.isReconnecting = true;
    this.reconnectAttempts++;
    
    // 计算延迟时间（指数退避，最大60秒）
    // 2s → 4s → 8s → 16s → 32s → 60s（之后保持60s）
    const baseDelay = 2000; // 2秒
    const maxDelay = 60000; // 60秒
    const delay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempts - 1), maxDelay);
    
    console.log(`准备在第 ${this.reconnectAttempts} 次尝试重连，延迟 ${delay}ms...`);
    
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
      
      const tabs = await chrome.tabs.query({});
      const activeTab = await chrome.tabs.query({ active: true, currentWindow: true });
      
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
let kaichiBrowserControl = null;

// Service Worker 启动时初始化
chrome.runtime.onStartup.addListener(() => {
  console.log('Service Worker 启动');
  kaichiBrowserControl = new KaichiBrowserControl();
});

// 扩展安装或更新时初始化
chrome.runtime.onInstalled.addListener(() => {
  console.log('扩展已安装/更新');
  if (!kaichiBrowserControl) {
    kaichiBrowserControl = new KaichiBrowserControl();
  }
});

// 确保在 Service Worker 激活时也初始化
if (!kaichiBrowserControl) {
  kaichiBrowserControl = new KaichiBrowserControl();
}
