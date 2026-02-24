/**
 * JS Eyes Builder
 *
 * Site build:  src/ → docs/  (landing page for GitHub Pages)
 * Chrome:      package chrome-extension/ into ZIP
 * Firefox:     package & sign firefox-extension/
 * Bump:        sync version across all manifests
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SRC_DIR = path.join(PROJECT_ROOT, 'src');
const DOCS_DIR = path.join(PROJECT_ROOT, 'docs');
const CHROME_DIR = path.join(PROJECT_ROOT, 'chrome-extension');
const FIREFOX_DIR = path.join(PROJECT_ROOT, 'firefox-extension');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist');
const SIGNED_DIR = path.join(PROJECT_ROOT, 'signed-firefox-extensions');
const PKG_PATH = path.join(PROJECT_ROOT, 'package.json');
const CHROME_MANIFEST = path.join(CHROME_DIR, 'manifest.json');
const FIREFOX_MANIFEST = path.join(FIREFOX_DIR, 'manifest.json');

const EXCLUDE_PATTERNS = [
    '.git/**', '**/.git/**', '**/.DS_Store', '**/Thumbs.db',
    '**/*.swp', '**/*.swo', '.amo-upload-uuid', 'node_modules/**',
];

// ── Helpers ──────────────────────────────────────────────────────────

function getVersion() {
    try {
        return JSON.parse(fs.readFileSync(PKG_PATH, 'utf8')).version || '1.0.0';
    } catch (e) {
        return '1.0.0';
    }
}

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function copyDirSync(src, dest) {
    ensureDir(dest);
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirSync(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

function loadEnvFile() {
    const envPaths = [
        path.join(PROJECT_ROOT, '.env'),
        path.join(process.cwd(), '.env'),
    ];
    for (const envPath of envPaths) {
        if (fs.existsSync(envPath)) {
            const content = fs.readFileSync(envPath, 'utf8');
            for (const line of content.split('\n')) {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('#')) {
                    const [key, ...rest] = trimmed.split('=');
                    if (key && rest.length > 0) {
                        process.env[key.trim()] = rest.join('=').replace(/^["']|["']$/g, '').trim();
                    }
                }
            }
            return envPath;
        }
    }
    return null;
}

function getApiConfig() {
    const apiKey = process.env.AMO_API_KEY;
    const apiSecret = process.env.AMO_API_SECRET;
    if (apiKey && apiSecret) return { apiKey, apiSecret };
    return null;
}

// ── Build: Site ──────────────────────────────────────────────────────

function buildSite(t, options = {}) {
    const { clean = false } = options;

    console.log('');
    console.log(t('site.header'));
    console.log('');

    if (!fs.existsSync(SRC_DIR)) {
        console.error(`  ✗ ${t('site.srcMissing')}`);
        process.exit(1);
    }

    if (clean && fs.existsSync(DOCS_DIR)) {
        const keep = ['README_CN.md'];
        const entries = fs.readdirSync(DOCS_DIR);
        for (const entry of entries) {
            if (keep.includes(entry)) continue;
            const fullPath = path.join(DOCS_DIR, entry);
            fs.rmSync(fullPath, { recursive: true, force: true });
        }
        console.log(`  ${t('site.cleaned')}`);
    }

    ensureDir(DOCS_DIR);

    copyDirSync(SRC_DIR, DOCS_DIR);
    console.log(`  ✓ ${t('site.copied')}`);

    const nojekyll = path.join(DOCS_DIR, '.nojekyll');
    if (!fs.existsSync(nojekyll)) {
        fs.writeFileSync(nojekyll, '');
    }
    console.log(`  ✓ ${t('site.nojekyll')}`);

    console.log(`  ✓ ${t('site.done')}`);
}

// ── Build: Chrome ────────────────────────────────────────────────────

async function buildChrome(t) {
    console.log('');
    console.log(t('chrome.header'));
    console.log('');

    const version = getVersion();

    if (!fs.existsSync(CHROME_DIR)) {
        console.error(`  ✗ ${t('chrome.dirMissing')}`);
        process.exit(1);
    }

    ensureDir(DIST_DIR);

    const outputFile = path.join(DIST_DIR, `js-eyes-chrome-v${version}.zip`);

    if (fs.existsSync(outputFile)) {
        fs.unlinkSync(outputFile);
        console.log(`  ${t('chrome.deletedOld')}`);
    }

    const archiver = require('archiver');
    const output = fs.createWriteStream(outputFile);
    const archive = archiver('zip', { zlib: { level: 9 } });

    return new Promise((resolve, reject) => {
        output.on('close', () => {
            const stats = fs.statSync(outputFile);
            console.log(`  ✓ ${t('chrome.done')}`);
            console.log(`  ${t('chrome.output').replace('{path}', outputFile)}`);
            console.log(`  ${t('chrome.size').replace('{size}', formatSize(stats.size))}`);
            resolve();
        });
        archive.on('error', (err) => {
            console.error(`  ✗ ${t('chrome.error').replace('{msg}', err.message)}`);
            reject(err);
        });
        archive.pipe(output);
        archive.glob('**/*', { cwd: CHROME_DIR, dot: false, ignore: EXCLUDE_PATTERNS });
        archive.finalize();
    });
}

// ── Build: Firefox ───────────────────────────────────────────────────

async function buildFirefox(t, sign = true) {
    console.log('');
    console.log(t('firefox.header'));
    console.log('');

    const version = getVersion();

    if (!fs.existsSync(FIREFOX_DIR)) {
        console.error(`  ✗ ${t('firefox.dirMissing')}`);
        process.exit(1);
    }
    if (!fs.existsSync(FIREFOX_MANIFEST)) {
        console.error(`  ✗ ${t('firefox.manifestMissing')}`);
        process.exit(1);
    }

    if (!sign) {
        console.log(`  ⚠ ${t('firefox.skipSign')}`);
        console.log(`  ${t('firefox.skipNote')}`);
        return;
    }

    const envPath = loadEnvFile();
    if (envPath) console.log(`  ${t('env.foundFile').replace('{path}', envPath)}`);

    console.log(`  ${t('firefox.checkPrereqs')}`);
    try {
        execSync('web-ext --version', { stdio: 'pipe' });
        console.log(`  ✓ ${t('firefox.webextOk')}`);
    } catch (_) {
        console.error(`  ✗ ${t('firefox.webextMissing')}`);
        console.log(`  ${t('firefox.webextInstall')}`);
        process.exit(1);
    }

    const apiCfg = getApiConfig();
    if (!apiCfg) {
        console.error(`  ✗ ${t('env.notFound')}`);
        console.log('');
        console.log(t('env.configHelp'));
        console.log('');
        console.log(t('env.optEnv'));
        console.log('  set AMO_API_KEY=your-api-key');
        console.log('  set AMO_API_SECRET=your-api-secret');
        console.log('');
        console.log(t('env.amoUrl'));
        process.exit(1);
    }
    console.log(`  ✓ ${t('env.fromEnv')}`);

    ensureDir(SIGNED_DIR);
    ensureDir(DIST_DIR);

    console.log(`  ${t('firefox.signing')}`);
    try {
        const cmd = `web-ext sign --api-key="${apiCfg.apiKey}" --api-secret="${apiCfg.apiSecret}" --artifacts-dir="${SIGNED_DIR}" --channel=unlisted`;
        console.log(`  ${t('firefox.execCmd').replace('{cmd}', cmd.replace(apiCfg.apiKey, '***').replace(apiCfg.apiSecret, '***'))}`);

        execSync(cmd, { cwd: FIREFOX_DIR, stdio: 'inherit' });
        console.log(`  ✓ ${t('firefox.signOk')}`);

        const xpiFiles = fs.readdirSync(SIGNED_DIR).filter(f => f.endsWith('.xpi'));
        if (xpiFiles.length > 0) {
            console.log(`  ${t('firefox.signedFiles')}`);
            xpiFiles.forEach(file => {
                const s = fs.statSync(path.join(SIGNED_DIR, file));
                console.log(`    - ${file} (${formatSize(s.size)})`);
            });
            const latest = xpiFiles.sort().reverse()[0];
            const distName = `js-eyes-firefox-v${version}.xpi`;
            const distPath = path.join(DIST_DIR, distName);
            fs.copyFileSync(path.join(SIGNED_DIR, latest), distPath);
            console.log(`  ${t('firefox.copiedToDist').replace('{file}', distName)}`);
            const s = fs.statSync(distPath);
            console.log(`  ${t('chrome.output').replace('{path}', distPath)}`);
            console.log(`  ${t('chrome.size').replace('{size}', formatSize(s.size))}`);
        }
    } catch (e) {
        console.error(`  ✗ ${t('firefox.signFailed').replace('{msg}', e.message)}`);
        process.exit(1);
    }
}

// ── Bump ─────────────────────────────────────────────────────────────

function bump(t, newVersion) {
    if (!newVersion) {
        console.error(`  ✗ ${t('bump.noVersion')}`);
        console.log(t('bump.usage'));
        console.log(t('bump.example'));
        process.exit(1);
    }
    if (!/^\d+\.\d+\.\d+$/.test(newVersion)) {
        console.error(`  ✗ ${t('bump.badFormat').replace('{version}', newVersion)}`);
        console.log(t('bump.expectedFormat'));
        process.exit(1);
    }

    const current = getVersion();
    console.log('');
    console.log(t('bump.header'));
    console.log('');
    console.log(`  ${t('bump.current').replace('{version}', current)}`);
    console.log(`  ${t('bump.new').replace('{version}', newVersion)}`);
    console.log('');

    const files = [
        { path: PKG_PATH, name: 'package.json' },
        { path: CHROME_MANIFEST, name: 'chrome-extension/manifest.json' },
        { path: FIREFOX_MANIFEST, name: 'firefox-extension/manifest.json' },
    ];

    for (const file of files) {
        if (!fs.existsSync(file.path)) {
            console.error(`  ✗ ${t('bump.fileMissing').replace('{name}', file.name)}`);
            process.exit(1);
        }
        try {
            const content = JSON.parse(fs.readFileSync(file.path, 'utf8'));
            const old = content.version;
            content.version = newVersion;
            fs.writeFileSync(file.path, JSON.stringify(content, null, 2) + '\n', 'utf8');
            console.log(`  ✓ ${t('bump.updated').replace('{name}', file.name).replace('{old}', old).replace('{new}', newVersion)}`);
        } catch (e) {
            console.error(`  ✗ ${t('bump.updateFailed').replace('{name}', file.name).replace('{msg}', e.message)}`);
            process.exit(1);
        }
    }

    console.log('');
    console.log(`  ${t('bump.done')}`);
}

// ── Exports ──────────────────────────────────────────────────────────

module.exports = {
    buildSite,
    buildChrome,
    buildFirefox,
    bump,
    getVersion,
};
