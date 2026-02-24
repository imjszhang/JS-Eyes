/**
 * Cloudflare API 配置
 * 为自定义域名设置 DNS 记录，指向 GitHub Pages
 *
 * 使用前请确保：
 * 1. .env 中配置 CLOUDFLARE_API_TOKEN 或 CLOUDFLARE_API_KEY
 * 2. 若使用 Global API Key，需额外配置 CLOUDFLARE_EMAIL
 * 3. 域名已添加到 Cloudflare（或脚本会自动尝试创建 Zone）
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

function getCloudflareConfig(domain, githubPagesTarget) {
    let domainVal = domain;
    let targetVal = githubPagesTarget;

    if (fs.existsSync(CONFIG_PATH)) {
        try {
            const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            if (config.cloudflare) {
                domainVal = domainVal || config.cloudflare.domain;
                targetVal = targetVal || config.cloudflare.githubPagesTarget;
            }
            if (config.pages?.githubRepo && !targetVal) {
                const [owner] = (config.pages.githubRepo || '').split('/');
                if (owner) targetVal = `${owner}.github.io`;
            }
        } catch (_) {}
    }

    return { domain: domainVal, githubPagesTarget: targetVal };
}

function getAuthHeaders(env) {
    const apiKey = env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_API_KEY || env.CLOUDFARE_API_KEY;
    const email = env.CLOUDFLARE_EMAIL;

    if (!apiKey) {
        throw new Error('请在 .env 中配置 CLOUDFLARE_API_TOKEN 或 CLOUDFLARE_API_KEY');
    }

    if (email) {
        return {
            'X-Auth-Email': email,
            'X-Auth-Key': apiKey,
            'Content-Type': 'application/json',
        };
    }
    return {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
    };
}

async function cfFetch(path, options = {}) {
    const url = `https://api.cloudflare.com/client/v4${path}`;
    const res = await fetch(url, options);
    const data = await res.json();
    if (!res.ok) {
        const err = data.errors?.[0] || { message: res.statusText };
        throw new Error(`Cloudflare API 错误: ${err.message} (code: ${err.code})`);
    }
    if (!data.success) {
        throw new Error(data.errors?.[0]?.message || 'API 请求失败');
    }
    return data;
}

async function getAccountId(headers) {
    const data = await cfFetch('/accounts', { headers });
    const accounts = data.result || [];
    if (accounts.length === 0) throw new Error('未找到 Cloudflare 账户');
    return accounts[0].id;
}

async function getZoneId(headers, domain) {
    const data = await cfFetch(`/zones?name=${domain}`, { headers });
    const zones = data.result || [];
    if (zones.length > 0) return zones[0].id;
    return null;
}

async function createZone(headers, accountId, domain, t) {
    const data = await cfFetch('/zones', {
        method: 'POST',
        headers,
        body: JSON.stringify({
            name: domain,
            account: { id: accountId },
            jump_start: true,
            type: 'full',
        }),
    });
    const zone = data.result;
    console.log(t('cf.zoneCreated').replace('{name}', zone.name).replace('{id}', zone.id));
    console.log(t('cf.nsHint').replace('{ns}', zone.name_servers.join(', ')));
    return zone.id;
}

async function listDnsRecords(headers, zoneId) {
    const data = await cfFetch(`/zones/${zoneId}/dns_records`, { headers });
    return data.result || [];
}

async function createOrUpdateDnsRecord(headers, zoneId, record, domain, t) {
    const { name, type, content, proxied = false } = record;
    const fullName = name === '@' ? domain : `${name}.${domain}`;

    const records = await listDnsRecords(headers, zoneId);
    const existing = records.find((r) => r.name === fullName && r.type === type);

    const body = { type, content, proxied, ttl: 1, name: fullName };

    if (existing) {
        await cfFetch(`/zones/${zoneId}/dns_records/${existing.id}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify(body),
        });
        console.log(t('cf.dnsUpdated').replace('{name}', fullName).replace('{type}', type).replace('{content}', content));
    } else {
        await cfFetch(`/zones/${zoneId}/dns_records`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });
        console.log(t('cf.dnsAdded').replace('{name}', fullName).replace('{type}', type).replace('{content}', content));
    }
}

async function setupCloudflare(domain, githubPagesTarget, t) {
    const config = getCloudflareConfig(domain, githubPagesTarget);
    const { domain: dom, githubPagesTarget: target } = config;

    if (!dom || !target) {
        throw new Error(
            '请指定域名和 GitHub Pages 目标。方式一: --domain xxx.com --target owner.github.io；方式二: 在 config.json 中配置 cloudflare.domain 和 cloudflare.githubPagesTarget'
        );
    }

    console.log('');
    console.log(t('cf.header').replace('{domain}', dom));
    console.log('');

    const env = loadEnv();
    const headers = getAuthHeaders(env);

    let zoneId = await getZoneId(headers, dom);
    if (!zoneId) {
        console.log(t('cf.zoneNotFound'));
        const accountId = await getAccountId(headers);
        zoneId = await createZone(headers, accountId, dom, t);
    } else {
        console.log(t('cf.zoneFound').replace('{domain}', dom));
    }

    const records = [
        { name: '@', type: 'CNAME', content: target, proxied: false },
        { name: 'www', type: 'CNAME', content: target, proxied: false },
    ];

    for (const record of records) {
        await createOrUpdateDnsRecord(headers, zoneId, record, dom, t);
    }

    console.log('');
    console.log(t('cf.done'));
    console.log(t('cf.ghPagesHint').replace('{domain}', dom));
}

module.exports = { setupCloudflare, getCloudflareConfig };
