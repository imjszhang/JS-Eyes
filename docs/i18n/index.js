/**
 * JS Eyes I18nManager
 * Lightweight i18n for static landing page.
 * Pattern: data-i18n / data-i18n-html attributes + localStorage persistence.
 */
window.I18nLocales = window.I18nLocales || {};

const I18nManager = (() => {
    const STORAGE_KEY = 'js-eyes-locale';
    const DEFAULT_LOCALE = 'en-US';
    const SUPPORTED = ['en-US', 'zh-CN'];
    let currentLocale = DEFAULT_LOCALE;

    function _resolve(obj, dotKey) {
        return dotKey.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : null), obj);
    }

    function init() {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved && SUPPORTED.includes(saved)) {
            currentLocale = saved;
        } else {
            const lang = navigator.language || navigator.userLanguage || '';
            currentLocale = lang.startsWith('zh') ? 'zh-CN' : 'en-US';
        }
        updateDOM();
        document.documentElement.lang = currentLocale === 'zh-CN' ? 'zh-CN' : 'en';
    }

    function getLocale() {
        return currentLocale;
    }

    function setLocale(locale) {
        if (!SUPPORTED.includes(locale)) return;
        currentLocale = locale;
        localStorage.setItem(STORAGE_KEY, locale);
        updateDOM();
        document.documentElement.lang = currentLocale === 'zh-CN' ? 'zh-CN' : 'en';
        window.dispatchEvent(new CustomEvent('localechange', { detail: { locale } }));
    }

    function t(key) {
        const pack = window.I18nLocales[currentLocale];
        if (!pack) return key;
        return _resolve(pack, key) || key;
    }

    function updateDOM() {
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const val = t(el.getAttribute('data-i18n'));
            if (val) el.textContent = val;
        });
        document.querySelectorAll('[data-i18n-html]').forEach(el => {
            const val = t(el.getAttribute('data-i18n-html'));
            if (val) el.innerHTML = val;
        });
        document.querySelectorAll('[data-i18n-title]').forEach(el => {
            const val = t(el.getAttribute('data-i18n-title'));
            if (val) el.title = val;
        });
        document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            const val = t(el.getAttribute('data-i18n-placeholder'));
            if (val) el.placeholder = val;
        });
    }

    return { init, getLocale, setLocale, t, updateDOM };
})();
