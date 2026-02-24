/**
 * CLI I18n Module
 * Auto-detects system locale, supports --lang flag override.
 */

const path = require('path');

const SUPPORTED = ['en-US', 'zh-CN'];
const DEFAULT_LOCALE = 'zh-CN';

let currentLocale = DEFAULT_LOCALE;
let messages = {};

function detectLocale() {
    const envLang = process.env.LANG || process.env.LC_ALL || process.env.LC_MESSAGES || '';
    if (envLang.startsWith('en')) return 'en-US';
    if (envLang.startsWith('zh')) return 'zh-CN';

    try {
        const os = require('os');
        const sysLocale = Intl.DateTimeFormat().resolvedOptions().locale || '';
        if (sysLocale.startsWith('en')) return 'en-US';
        if (sysLocale.startsWith('zh')) return 'zh-CN';
    } catch (_) {}

    return DEFAULT_LOCALE;
}

function init(argv) {
    const langIdx = argv.indexOf('--lang');
    if (langIdx !== -1 && argv[langIdx + 1] && SUPPORTED.includes(argv[langIdx + 1])) {
        currentLocale = argv[langIdx + 1];
    } else {
        currentLocale = detectLocale();
    }

    messages = require(path.join(__dirname, 'locales', currentLocale + '.js'));
}

function t(key) {
    return key.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : null), messages) || key;
}

function getLocale() {
    return currentLocale;
}

module.exports = { init, t, getLocale, SUPPORTED };
