/**
 * GitHub Pages 自定义域名 API 配置
 * 通过 GitHub API 设置 Pages 自定义域名
 *
 * 使用前请确保：
 * 1. .env 中配置 GITHUB_TOKEN（Personal Access Token）
 * 2. Token 需 repo 权限，或 Fine-grained 需 Pages + Administration 写权限
 * 3. 创建地址：https://github.com/settings/tokens
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config.json');

function loadEnv() {
    const env = { ...process.env };
    const envPath = path.join(PROJECT_ROOT, '.env');
    if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf8');
        for (const line of content.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eq = trimmed.indexOf('=');
            if (eq > 0) {
                const key = trimmed.slice(0, eq).trim();
                const val = trimmed.slice(eq + 1).replace(/^["']|["']$/g, '').trim();
                if (key) env[key] = val;
            }
        }
    }
    return env;
}

function getPagesConfig(domain, githubRepo) {
    let domainVal = domain;
    let repoVal = githubRepo;

    if (fs.existsSync(CONFIG_PATH)) {
        try {
            const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            if (config.pages) {
                domainVal = domainVal || config.pages.domain;
                repoVal = repoVal || config.pages.githubRepo;
            }
        } catch (_) {}
    }

    return { domain: domainVal, githubRepo: repoVal };
}

async function ghFetch(path, options = {}) {
    const env = loadEnv();
    const token = env.GITHUB_TOKEN;
    if (!token) {
        throw new Error('请在 .env 中配置 GITHUB_TOKEN');
    }
    const url = `https://api.github.com${path}`;
    const headers = {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...options.headers,
    };
    const res = await fetch(url, { ...options, headers });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
        const msg = data?.message || res.statusText;
        throw new Error(`GitHub API 错误: ${msg}`);
    }
    return data;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function updatePages(owner, repo, body) {
    await ghFetch(`/repos/${owner}/${repo}/pages`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

async function setupGitHubPages(domain, githubRepo, t) {
    const config = getPagesConfig(domain, githubRepo);
    const { domain: dom, githubRepo: repo } = config;

    if (!dom || !repo) {
        throw new Error(
            '请指定域名和仓库。方式一: --domain xxx.com --repo owner/repo；方式二: 在 config.json 中配置 pages.domain 和 pages.githubRepo'
        );
    }

    let [owner, repoName] = repo.split('/');
    if (!owner || !repoName) {
        throw new Error('githubRepo 格式应为 owner/repo');
    }

    console.log('');
    console.log(t('ghPages.header'));
    console.log('');

    let source = { branch: 'main', path: '/docs' };
    try {
        const repoInfo = await ghFetch(`/repos/${owner}/${repo}`);
        owner = repoInfo.owner?.login || owner;
        repoName = repoInfo.name || repoName;
        source.branch = repoInfo.default_branch || 'main';
    } catch (_) {}

    const repoSlug = `${owner}/${repoName}`;
    try {
        const pages = await ghFetch(`/repos/${repoSlug}/pages`);
        if (pages.source) {
            source = { branch: pages.source.branch, path: pages.source.path || '/' };
        }
    } catch (e) {
        if (e.message.includes('404') || e.message.includes('Not Found')) {
            console.log(t('ghPages.creating'));
            try {
                await ghFetch(`/repos/${repoSlug}/pages`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ source }),
                });
                console.log(t('ghPages.created').replace('{branch}', source.branch).replace('{path}', source.path));
            } catch (createErr) {
                if (createErr.message.includes('404') || createErr.message.includes('Not Found')) {
                    throw new Error(t('ghPages.createFailed'));
                }
                throw createErr;
            }
        } else {
            throw e;
        }
    }

    console.log(t('ghPages.settingDomain').replace('{domain}', dom));
    await updatePages(owner, repoName, { cname: dom, source });
    console.log(t('ghPages.waitVerify'));
    console.log('');

    const maxAttempts = 24;
    const intervalMs = 5000;
    let domainVerified = false;

    for (let i = 0; i < maxAttempts; i++) {
        await sleep(intervalMs);
        const pages = await ghFetch(`/repos/${repoSlug}/pages`);
        const state = pages.protected_domain_state || '';
        const certState = pages.https_certificate?.state || '';

        console.log(t('ghPages.pollStatus').replace('{i}', i + 1).replace('{max}', maxAttempts).replace('{state}', state).replace('{cert}', certState));

        if (certState === 'approved') {
            domainVerified = true;
            break;
        }
    }

    if (!domainVerified) {
        console.log('');
        console.log(t('ghPages.timeout'));
        return;
    }

    console.log('');
    console.log(t('ghPages.enableHttps'));
    await updatePages(owner, repoName, { cname: dom, source, https_enforced: true });
    console.log(t('ghPages.httpsDone'));
}

module.exports = { setupGitHubPages, getPagesConfig };
