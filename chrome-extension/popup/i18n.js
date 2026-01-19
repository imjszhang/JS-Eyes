/**
 * JS Eyes Browser Extension - i18n Helper Module (Chrome)
 * 
 * 处理国际化翻译的辅助模块
 */

const I18n = {
  /**
   * 获取翻译消息
   * @param {string} key - 消息键
   * @param {string|string[]} [substitutions] - 替换参数
   * @returns {string} 翻译后的消息
   */
  getMessage(key, substitutions) {
    const message = chrome.i18n.getMessage(key, substitutions);
    return message || key;
  },

  /**
   * 初始化页面上所有带 data-i18n 属性的元素
   */
  initPage() {
    // 翻译 textContent
    document.querySelectorAll('[data-i18n]').forEach(element => {
      const key = element.getAttribute('data-i18n');
      const message = this.getMessage(key);
      if (message && message !== key) {
        element.textContent = message;
      }
    });

    // 翻译 placeholder 属性
    document.querySelectorAll('[data-i18n-placeholder]').forEach(element => {
      const key = element.getAttribute('data-i18n-placeholder');
      const message = this.getMessage(key);
      if (message && message !== key) {
        element.placeholder = message;
      }
    });

    // 翻译 title 属性
    document.querySelectorAll('[data-i18n-title]').forEach(element => {
      const key = element.getAttribute('data-i18n-title');
      const message = this.getMessage(key);
      if (message && message !== key) {
        element.title = message;
      }
    });

    // 设置页面语言
    const uiLanguage = chrome.i18n.getUILanguage();
    document.documentElement.lang = uiLanguage.startsWith('zh') ? 'zh-CN' : 'en';
  },

  /**
   * 翻译单个元素
   * @param {HTMLElement} element - 要翻译的元素
   * @param {string} key - 消息键
   */
  translateElement(element, key) {
    const message = this.getMessage(key);
    if (message && message !== key) {
      element.textContent = message;
    }
  }
};

// 页面加载时自动初始化
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => I18n.initPage());
} else {
  I18n.initPage();
}

// 导出供其他模块使用
if (typeof module !== 'undefined' && module.exports) {
  module.exports = I18n;
}
