/**
 * JS-Eyes Node.js Client (v1.0.0)
 *
 * 通过 WebSocket 与 JS-Eyes Server 通信，控制浏览器扩展执行自动化操作。
 * 单文件自包含，可直接复制到任意 Node.js 项目中使用。
 *
 * 外部依赖：ws (npm install ws)
 * 兼容服务端：js-eyes/server >= 1.0.0
 *
 * 用法：
 *   const { BrowserAutomation } = require('./js-eyes-client');
 *   const bot = new BrowserAutomation('ws://localhost:18080');
 *   await bot.connect();
 *   const tabs = await bot.getTabs();
 *
 * 变更历史：
 * - v1.0.0：基于 agent-js/browserAutomation.js v3.1.1 改写，适配 JS-Eyes server 协议
 */

'use strict';

const WebSocket = require('ws');

class BrowserAutomation {
  /**
   * @param {string} [serverUrl='ws://localhost:18080'] WebSocket 服务器地址
   * @param {Object} [options]
   * @param {number} [options.requestInterval=200] 请求最小间隔（ms）
   * @param {number} [options.defaultTimeout=60] 默认请求超时（秒）
   * @param {Object} [options.logger=console] 日志对象，需实现 info/warn/error
   */
  constructor(serverUrl, options = {}) {
    this.serverUrl = this._normalizeWsUrl(serverUrl || 'ws://localhost:18080');
    this.logger = options.logger || console;
    this.defaultTimeout = options.defaultTimeout || 60;

    this.requestInterval = options.requestInterval || 200;
    this._lastRequestTime = 0;

    this.ws = null;
    this._wsState = 'disconnected'; // disconnected | connecting | connected
    this._clientId = null;
    this._intentionalClose = false;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._maxReconnectDelay = 60000;
    this._connectPromise = null;

    this.pendingRequests = new Map(); // requestId -> { resolve, reject, timeoutId }

    this._processCleanup = () => {
      try { this.disconnect(); } catch {}
    };
    process.on('SIGINT', this._processCleanup);
    process.on('SIGTERM', this._processCleanup);
    process.on('exit', this._processCleanup);
  }

  /**
   * 将用户传入的 URL 统一为 ws:// 格式
   */
  _normalizeWsUrl(url) {
    if (url.startsWith('http://')) return url.replace('http://', 'ws://');
    if (url.startsWith('https://')) return url.replace('https://', 'wss://');
    if (!url.startsWith('ws://') && !url.startsWith('wss://')) return `ws://${url}`;
    return url;
  }

  // ─── connection management ──────────────────────────────────────────

  /**
   * 建立 WebSocket 连接，等待 connection_established 确认
   */
  async connect() {
    if (this._wsState === 'connected' && this.ws?.readyState === WebSocket.OPEN) {
      return;
    }
    if (this._connectPromise) {
      return this._connectPromise;
    }

    this._intentionalClose = false;

    this._connectPromise = new Promise((resolve, reject) => {
      this._wsState = 'connecting';
      const wsUrl = `${this.serverUrl}?type=automation`;

      this.logger.info(`[JS-Eyes] 正在连接: ${wsUrl}`);

      try {
        this.ws = new WebSocket(wsUrl);
      } catch (err) {
        this._wsState = 'disconnected';
        this._connectPromise = null;
        reject(new Error(`WebSocket 创建失败: ${err.message}`));
        return;
      }

      const connectTimeout = setTimeout(() => {
        if (this._wsState === 'connecting') {
          this.ws.terminate();
          this._wsState = 'disconnected';
          this._connectPromise = null;
          reject(new Error('WebSocket 连接超时 (10s)'));
        }
      }, 10000);

      this.ws.on('open', () => {
        this.logger.info('[JS-Eyes] TCP 连接已建立，等待服务端确认...');
      });

      this.ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        if (msg.type === 'connection_established') {
          clearTimeout(connectTimeout);
          this._clientId = msg.clientId;
          this._wsState = 'connected';
          this._reconnectAttempts = 0;
          this._connectPromise = null;
          this.logger.info(`[JS-Eyes] 连接已建立 (clientId=${msg.clientId})`);

          // 切换到正常消息处理
          this.ws.removeAllListeners('message');
          this.ws.on('message', (d) => this._handleMessage(d));
          resolve();
          return;
        }
      });

      this.ws.on('close', (code, reason) => {
        clearTimeout(connectTimeout);
        if (this._wsState === 'connecting') {
          this._wsState = 'disconnected';
          this.ws = null;
          this._connectPromise = null;
          reject(new Error(`WebSocket 连接关闭: code=${code}`));
        } else {
          this._handleWsClose(code, reason);
        }
      });

      this.ws.on('error', (err) => {
        this.logger.error(`[JS-Eyes] 连接错误: ${err.message}`);
      });
    });

    return this._connectPromise;
  }

  disconnect() {
    this._intentionalClose = true;

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('WebSocket 连接已主动关闭'));
    }
    this.pendingRequests.clear();

    if (this.ws) {
      try { this.ws.close(1000, 'Client disconnect'); } catch {}
      this.ws = null;
    }

    this._wsState = 'disconnected';
    this._connectPromise = null;
    this._clientId = null;

    process.removeListener('SIGINT', this._processCleanup);
    process.removeListener('SIGTERM', this._processCleanup);
    process.removeListener('exit', this._processCleanup);

    this.logger.info('[JS-Eyes] 已断开连接');
  }

  /**
   * 懒连接：首次调用时建立连接，后续直接返回
   */
  async ensureConnected() {
    if (this._wsState === 'connected' && this.ws?.readyState === WebSocket.OPEN) {
      return;
    }
    await this.connect();
  }

  _scheduleReconnect() {
    if (this._intentionalClose || this._reconnectTimer) return;

    this._reconnectAttempts++;
    const delay = Math.min(2000 * Math.pow(2, this._reconnectAttempts - 1), this._maxReconnectDelay);

    this.logger.info(`[JS-Eyes] 将在 ${delay}ms 后重连 (第 ${this._reconnectAttempts} 次)`);

    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      try {
        await this.connect();
      } catch (err) {
        this.logger.error(`[JS-Eyes] 重连失败: ${err.message}`);
        this._scheduleReconnect();
      }
    }, delay);
  }

  _handleMessage(rawData) {
    let msg;
    try { msg = JSON.parse(rawData.toString()); } catch { return; }

    if (msg.type === 'error' && !msg.requestId) {
      this.logger.error(`[JS-Eyes] 服务端错误: ${msg.message || JSON.stringify(msg)}`);
      return;
    }

    if (msg.requestId) {
      const pending = this.pendingRequests.get(msg.requestId);
      if (pending) {
        clearTimeout(pending.timeoutId);
        this.pendingRequests.delete(msg.requestId);

        if (msg.status === 'error' || msg.type === 'error') {
          pending.reject(new Error(msg.message || '未知错误'));
        } else {
          pending.resolve(msg);
        }
      }
    }
  }

  _handleWsClose(code, reason) {
    this._wsState = 'disconnected';
    this.ws = null;
    this._clientId = null;

    this.logger.info(`[JS-Eyes] 连接关闭: code=${code}, reason=${reason || 'N/A'}`);

    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('WebSocket 连接已断开'));
    }
    this.pendingRequests.clear();

    if (!this._intentionalClose) {
      this._scheduleReconnect();
    }
  }

  // ─── core request ───────────────────────────────────────────────────

  _generateRequestId() {
    return 'req_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  /**
   * 发送 WS 请求并等待响应
   * @param {string} action 操作类型
   * @param {Object} payload 请求负载（不含 type/requestId）
   * @param {Object} [options]
   * @param {number} [options.timeout] 超时秒数
   * @param {string} [options.target] 目标浏览器 clientId 或 browserName
   * @returns {Promise<Object>} 完整响应消息
   */
  async _sendRequest(action, payload = {}, options = {}) {
    const now = Date.now();
    const wait = this.requestInterval - (now - this._lastRequestTime);
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }
    this._lastRequestTime = Date.now();

    await this.ensureConnected();

    const requestId = this._generateRequestId();
    const timeoutSec = options.timeout || this.defaultTimeout;

    const message = { type: action, requestId, ...payload };
    if (options.target) {
      message.target = options.target;
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`请求超时: action=${action}, requestId=${requestId}, timeout=${timeoutSec}s`));
      }, timeoutSec * 1000);

      this.pendingRequests.set(requestId, { resolve, reject, timeoutId });

      try {
        this.ws.send(JSON.stringify(message));
      } catch (err) {
        clearTimeout(timeoutId);
        this.pendingRequests.delete(requestId);
        reject(new Error(`WebSocket 发送失败: ${err.message}`));
      }
    });
  }

  // ─── tab operations ─────────────────────────────────────────────────

  /**
   * 获取所有标签页
   * @param {Object} [options]
   * @param {string} [options.target] 目标浏览器
   * @returns {Promise<Object>} { browsers, tabs, activeTabId }
   */
  async getTabs(options = {}) {
    const resp = await this._sendRequest('get_tabs', {}, options);
    return resp.data || { browsers: [], tabs: [], activeTabId: null };
  }

  /**
   * 获取所有已连接的浏览器扩展客户端
   * @returns {Promise<Array>} 客户端列表
   */
  async listClients(options = {}) {
    const resp = await this._sendRequest('list_clients', {}, options);
    return resp.data?.clients || [];
  }

  /**
   * 打开 URL（新标签页或导航已有标签页）
   * @param {string} url
   * @param {number|null} [tabId] 已有标签页 ID（传入则导航，否则新开）
   * @param {number|null} [windowId] 窗口 ID（新开标签页时可指定窗口）
   * @param {Object} [options]
   * @param {string} [options.target] 目标浏览器
   * @param {number} [options.timeout] 超时秒数
   * @returns {Promise<number>} 标签页 ID
   */
  async openUrl(url, tabId = null, windowId = null, options = {}) {
    const payload = { url };
    if (tabId !== null) payload.tabId = parseInt(tabId);
    if (windowId !== null) payload.windowId = parseInt(windowId);

    const resp = await this._sendRequest('open_url', payload, options);
    return resp.tabId;
  }

  /**
   * 关闭标签页
   * @param {number} tabId
   * @param {Object} [options]
   * @returns {Promise<void>}
   */
  async closeTab(tabId, options = {}) {
    await this._sendRequest('close_tab', { tabId: parseInt(tabId) }, options);
  }

  /**
   * 获取标签页 HTML
   * @param {number} tabId
   * @param {Object} [options]
   * @returns {Promise<string>} HTML 内容
   */
  async getTabHtml(tabId, options = {}) {
    const resp = await this._sendRequest('get_html', { tabId: parseInt(tabId) }, options);
    return resp.html;
  }

  /**
   * 在标签页中执行 JavaScript
   * @param {number} tabId
   * @param {string} code
   * @param {Object} [options]
   * @returns {Promise<any>} 执行结果
   */
  async executeScript(tabId, code, options = {}) {
    if (typeof options === 'number') options = { timeout: options };
    const resp = await this._sendRequest('execute_script', {
      tabId: parseInt(tabId),
      code,
    }, options);
    return resp.result;
  }

  /**
   * 注入 CSS 到标签页
   * @param {number} tabId
   * @param {string} css
   * @param {Object} [options]
   * @returns {Promise<void>}
   */
  async injectCss(tabId, css, options = {}) {
    await this._sendRequest('inject_css', {
      tabId: parseInt(tabId),
      css,
    }, options);
  }

  /**
   * 获取标签页 cookies
   * @param {number} tabId
   * @param {Object} [options]
   * @returns {Promise<Array>} cookies 数组
   */
  async getCookies(tabId, options = {}) {
    const resp = await this._sendRequest('get_cookies', { tabId: parseInt(tabId) }, options);
    return resp.cookies || [];
  }
}

module.exports = { BrowserAutomation };
