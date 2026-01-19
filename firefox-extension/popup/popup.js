/**
 * JS Eyes Browser Extension - Popup Script (Firefox)
 * 
 * 处理popup界面的交互和状态显示
 */

class JSEyesPopup {
  constructor() {
    this.isInitialized = false;
    this.updateInterval = null;
    this.logs = [];
    this.maxLogs = 50;
    
    this.init();
  }

  /**
   * 初始化popup
   */
  async init() {
    if (this.isInitialized) return;
    
    console.log('JS Eyes Popup 正在初始化...');
    
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
   * 设置popup
   */
  setup() {
    // 设置事件监听器
    this.setupEventListeners();
    
    // 加载设置
    this.loadSettings();
    
    // 更新版本号
    this.updateVersion();
    
    // 更新状态
    this.updateStatus();
    
    // 开始定期更新
    this.startPeriodicUpdate();
    
    // 添加初始日志
    this.addLog(browser.i18n.getMessage('logPopupInit'));
    
    console.log('JS Eyes Popup 初始化完成');
  }

  /**
   * 更新版本号显示
   */
  async updateVersion() {
    try {
      // 尝试从 manifest 读取版本号
      const manifest = browser.runtime.getManifest();
      if (manifest && manifest.version) {
        const versionBadge = document.getElementById('version-badge');
        if (versionBadge) {
          // 显示应用版本号
          versionBadge.textContent = `v${manifest.version}`;
        }
      }
    } catch (error) {
      console.error('Failed to read version:', error);
    }
  }

  /**
   * 设置事件监听器
   */
  setupEventListeners() {
    // 重新连接按钮
    document.getElementById('reconnect-btn').addEventListener('click', () => {
      this.reconnect();
    });
    
    // 发送数据按钮
    document.getElementById('send-data-btn').addEventListener('click', () => {
      this.sendData();
    });
    
    // 刷新标签页按钮
    document.getElementById('refresh-tabs').addEventListener('click', () => {
      this.refreshTabs();
    });
    
    // 清空日志按钮
    document.getElementById('clear-logs').addEventListener('click', () => {
      this.clearLogs();
    });
    
    // 保存服务器地址按钮
    document.getElementById('save-server').addEventListener('click', () => {
      this.saveServerUrl();
    });
    
    // 自动连接开关
    document.getElementById('auto-connect').addEventListener('change', (e) => {
      this.toggleAutoConnect(e.target.checked);
    });
    
    // 设置项变更
    document.getElementById('debug-mode').addEventListener('change', (e) => {
      this.saveSetting('debugMode', e.target.checked);
    });
    
    // 服务器地址输入框回车
    document.getElementById('server-input').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        this.saveServerUrl();
      }
    });
    
    // 预设按钮点击事件
    document.querySelectorAll('.btn-preset').forEach(button => {
      button.addEventListener('click', (e) => {
        const url = e.target.getAttribute('data-url');
        this.selectPresetUrl(url);
      });
    });
  }

  /**
   * 加载设置
   */
  async loadSettings() {
    try {
      const result = await browser.storage.local.get([
        'serverUrl',
        'autoConnect',
        'debugMode'
      ]);
      
      // 设置服务器地址
      if (result.serverUrl) {
        document.getElementById('server-input').value = result.serverUrl;
      }
      
      // 设置自动连接（默认启用）
      if (result.autoConnect !== undefined) {
        document.getElementById('auto-connect').checked = result.autoConnect;
      } else {
        document.getElementById('auto-connect').checked = true; // 默认启用
      }
      
      // 设置调试模式
      if (result.debugMode !== undefined) {
        document.getElementById('debug-mode').checked = result.debugMode;
      }
      
    } catch (error) {
      console.error('加载设置时出错:', error);
      this.addLog(browser.i18n.getMessage('logFailedLoadSettings', error.message));
    }
  }

  /**
   * 保存设置
   */
  async saveSetting(key, value) {
    try {
      await browser.storage.local.set({ [key]: value });
      this.addLog(browser.i18n.getMessage('logSettingSaved', [key, String(value)]));
    } catch (error) {
      console.error('保存设置时出错:', error);
      this.addLog(browser.i18n.getMessage('logFailedSaveSetting', error.message));
    }
  }

  /**
   * 切换自动连接设置
   */
  async toggleAutoConnect(enabled) {
    try {
      // 保存设置
      await this.saveSetting('autoConnect', enabled);
      
      // 通知background script更新自动连接设置
      const response = await browser.runtime.sendMessage({
        type: 'set_auto_connect',
        autoConnect: enabled
      });
      
      if (response && response.success) {
        this.addLog(enabled ? 
          browser.i18n.getMessage('logAutoConnectEnabled') : 
          browser.i18n.getMessage('logAutoConnectDisabled')
        );
        
        // 延迟更新状态
        setTimeout(() => {
          this.updateStatus();
        }, 1000);
      } else {
        this.addLog(browser.i18n.getMessage('logFailedUpdateAutoConnect'));
      }
      
    } catch (error) {
      console.error('切换自动连接时出错:', error);
      this.addLog(browser.i18n.getMessage('logFailedToggleAutoConnect', error.message));
    }
  }

  /**
   * 选择预设URL
   */
  selectPresetUrl(url) {
    const serverInput = document.getElementById('server-input');
    serverInput.value = url;
    
    // 添加视觉反馈 - 使用 Neo-Brutalism 样式
    serverInput.classList.add('shadow-brutal-lg');
    setTimeout(() => {
      serverInput.classList.remove('shadow-brutal-lg');
    }, 1000);
    
    this.addLog(browser.i18n.getMessage('logPresetSelected', url));
  }

  /**
   * 保存服务器地址
   */
  async saveServerUrl() {
    const serverUrl = document.getElementById('server-input').value.trim();
    
    if (!serverUrl) {
      this.addLog(browser.i18n.getMessage('logServerEmpty'));
      return;
    }
    
    if (!serverUrl.startsWith('ws://') && !serverUrl.startsWith('wss://')) {
      this.addLog(browser.i18n.getMessage('logServerInvalidProtocol'));
      return;
    }
    
    try {
      await this.saveSetting('serverUrl', serverUrl);
      this.addLog(browser.i18n.getMessage('logServerSaved', serverUrl));
      
      // 更新显示
      document.getElementById('server-url').textContent = serverUrl;
      
      // 自动触发重新连接
      this.addLog(browser.i18n.getMessage('logApplyingReconnect'));
      await this.reconnect();
      
    } catch (error) {
      console.error('保存服务器地址时出错:', error);
      this.addLog(browser.i18n.getMessage('logFailedSaveServer', error.message));
    }
  }

  /**
   * 更新状态
   */
  async updateStatus() {
    try {
      // 获取background script的连接状态
      const response = await browser.runtime.sendMessage({
        type: 'get_connection_status'
      });
      
      if (response) {
        this.updateConnectionStatus(response);
      }
      
      // 获取当前标签页信息
      await this.updateCurrentTabInfo();
      
      // 获取浏览器统计
      await this.updateBrowserStats();
      
    } catch (error) {
      console.error('更新状态时出错:', error);
      this.addLog(browser.i18n.getMessage('logFailedUpdateStatus', error.message));
    }
  }

  /**
   * 更新连接状态
   */
  updateConnectionStatus(status) {
    const statusElement = document.getElementById('connection-status');
    const serverUrlElement = document.getElementById('server-url');
    const reconnectAttemptsElement = document.getElementById('reconnect-attempts');
    
    // 更新连接状态 - 使用 Neo-Brutalism 样式类
    const baseClasses = 'status-badge px-3 py-1 text-xs font-bold uppercase';
    if (status.isConnected) {
      statusElement.textContent = browser.i18n.getMessage('statusConnected');
      statusElement.className = `${baseClasses} connected`;
    } else if (status.isConnecting) {
      statusElement.textContent = browser.i18n.getMessage('statusConnecting');
      statusElement.className = `${baseClasses} connecting pulse`;
    } else {
      statusElement.textContent = browser.i18n.getMessage('statusDisconnected');
      statusElement.className = `${baseClasses} disconnected`;
    }
    
    // 更新服务器地址
    if (status.serverUrl) {
      serverUrlElement.textContent = status.serverUrl;
    }
    
    // 更新重连次数
    reconnectAttemptsElement.textContent = status.reconnectAttempts || 0;
  }

  /**
   * 更新当前标签页信息
   */
  async updateCurrentTabInfo() {
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      
      if (tabs.length > 0) {
        const tab = tabs[0];
        
        document.getElementById('current-tab-title').textContent = tab.title || '-';
        document.getElementById('current-tab-url').textContent = tab.url || '-';
        document.getElementById('current-tab-id').textContent = tab.id || '-';
      } else {
        document.getElementById('current-tab-title').textContent = '-';
        document.getElementById('current-tab-url').textContent = '-';
        document.getElementById('current-tab-id').textContent = '-';
      }
      
    } catch (error) {
      console.error('更新当前标签页信息时出错:', error);
    }
  }

  /**
   * 更新浏览器统计
   */
  async updateBrowserStats() {
    try {
      const [tabs, windows] = await Promise.all([
        browser.tabs.query({}),
        browser.windows.getAll()
      ]);
      
      document.getElementById('total-tabs').textContent = tabs.length;
      document.getElementById('total-windows').textContent = windows.length;
      
      // 更新最后同步时间
      const now = new Date();
      const timeString = now.toLocaleTimeString('zh-CN', { 
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
      document.getElementById('last-sync').textContent = timeString;
      
    } catch (error) {
      console.error('更新浏览器统计时出错:', error);
    }
  }

  /**
   * 开始定期更新
   */
  startPeriodicUpdate() {
    // 每5秒更新一次状态
    this.updateInterval = setInterval(() => {
      this.updateStatus();
    }, 5000);
  }

  /**
   * 停止定期更新
   */
  stopPeriodicUpdate() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  /**
   * 重新连接
   */
  async reconnect() {
    try {
      this.addLog(browser.i18n.getMessage('logReconnecting'));
      
      // 通知background script使用新设置重新连接
      const response = await browser.runtime.sendMessage({
        type: 'reconnect'
      });
      
      if (response && response.success) {
        this.addLog(browser.i18n.getMessage('logReconnectSent'));
        
        // 延迟更新状态，给连接一些时间
        setTimeout(() => {
          this.updateStatus();
        }, 2000);
      } else {
        this.addLog(browser.i18n.getMessage('logReconnectFailed'));
      }
      
    } catch (error) {
      console.error('重新连接时出错:', error);
      this.addLog(browser.i18n.getMessage('logFailedReconnect', error.message));
    }
  }

  /**
   * 发送数据
   */
  async sendData() {
    try {
      this.addLog(browser.i18n.getMessage('logSendingData'));
      
      // 通知background script发送数据
      const response = await browser.runtime.sendMessage({
        type: 'send_tabs_data'
      });
      
      if (response && response.success) {
        this.addLog(browser.i18n.getMessage('logDataSentSuccess'));
        
        // 更新数据发送计数
        const currentCount = parseInt(document.getElementById('data-sent').textContent) || 0;
        document.getElementById('data-sent').textContent = currentCount + 1;
      } else {
        this.addLog(browser.i18n.getMessage('logDataSentFailed'));
      }
      
    } catch (error) {
      console.error('发送数据时出错:', error);
      this.addLog(browser.i18n.getMessage('logFailedSendData', error.message));
    }
  }

  /**
   * 刷新标签页
   */
  async refreshTabs() {
    try {
      this.addLog(browser.i18n.getMessage('logRefreshingTabs'));
      
      await this.updateCurrentTabInfo();
      await this.updateBrowserStats();
      
      this.addLog(browser.i18n.getMessage('logTabsRefreshed'));
      
    } catch (error) {
      console.error('刷新标签页时出错:', error);
      this.addLog(browser.i18n.getMessage('logFailedRefreshTabs', error.message));
    }
  }

  /**
   * 添加日志
   */
  addLog(message) {
    const now = new Date();
    const timeString = now.toLocaleTimeString('zh-CN', { 
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    
    const logEntry = {
      time: timeString,
      message: message,
      timestamp: now.getTime()
    };
    
    // 添加到日志数组
    this.logs.unshift(logEntry);
    
    // 限制日志数量
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(0, this.maxLogs);
    }
    
    // 更新显示
    this.updateLogsDisplay();
    
    console.log(`[${timeString}] ${message}`);
  }

  /**
   * 更新日志显示
   */
  updateLogsDisplay() {
    const container = document.getElementById('logs-container');
    
    // 清空现有内容
    container.innerHTML = '';
    
    // 添加日志项 - 使用 Neo-Brutalism 样式类
    this.logs.forEach(log => {
      const logItem = document.createElement('div');
      logItem.className = 'flex gap-2 py-1 text-xs border-b-3 border-brand-yellow last:border-b-0';
      
      const timeSpan = document.createElement('span');
      timeSpan.className = 'text-brand-yellow font-mono min-w-[60px] font-bold';
      timeSpan.textContent = log.time;
      
      const messageSpan = document.createElement('span');
      messageSpan.className = 'text-brand-yellow flex-1 font-bold';
      messageSpan.textContent = log.message;
      
      logItem.appendChild(timeSpan);
      logItem.appendChild(messageSpan);
      container.appendChild(logItem);
    });
    
    // 滚动到顶部显示最新日志
    container.scrollTop = 0;
  }

  /**
   * 清空日志
   */
  clearLogs() {
    this.logs = [];
    this.updateLogsDisplay();
    this.addLog(browser.i18n.getMessage('logLogsCleared'));
  }

  /**
   * 销毁popup
   */
  destroy() {
    this.stopPeriodicUpdate();
    console.log('JS Eyes Popup 已销毁');
  }
}

// 初始化popup
const jsEyesPopup = new JSEyesPopup();

// 页面卸载时清理
window.addEventListener('beforeunload', () => {
  jsEyesPopup.destroy();
});

// 导出供其他脚本使用
if (typeof module !== 'undefined' && module.exports) {
  module.exports = JSEyesPopup;
}
