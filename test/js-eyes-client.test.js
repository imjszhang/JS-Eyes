'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');

const { BrowserAutomation } = require('../clients/js-eyes-client');

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

// ── mock server ─────────────────────────────────────────────────────

function createMockServer(handler) {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 });
    wss.on('listening', () => {
      const port = wss.address().port;
      wss.on('connection', (ws, req) => {
        const url = new URL(req.url, `ws://localhost:${port}`);
        const clientType = url.searchParams.get('type');

        if (clientType === 'automation') {
          ws.send(JSON.stringify({
            type: 'connection_established',
            clientId: 'test-client-id',
            timestamp: new Date().toISOString(),
          }));
        }

        ws.on('message', (raw) => {
          const data = JSON.parse(raw.toString());
          if (handler) {
            handler(ws, data);
          } else {
            defaultHandler(ws, data);
          }
        });
      });
      resolve({ wss, port, url: `ws://localhost:${port}` });
    });
  });
}

function defaultHandler(ws, data) {
  const action = data.action || data.type;
  const requestId = data.requestId;

  switch (action) {
    case 'get_tabs':
      ws.send(JSON.stringify({
        type: 'get_tabs_response', requestId, status: 'success',
        data: {
          browsers: [{ clientId: 'ext-1', browserName: 'firefox', tabCount: 2 }],
          tabs: [{ id: 1, url: 'https://a.com' }, { id: 2, url: 'https://b.com' }],
          activeTabId: 1,
        },
      }));
      break;

    case 'list_clients':
      ws.send(JSON.stringify({
        type: 'list_clients_response', requestId, status: 'success',
        data: {
          clients: [
            { clientId: 'ext-1', browserName: 'firefox', tabCount: 2 },
            { clientId: 'ext-2', browserName: 'chrome', tabCount: 1 },
          ],
        },
      }));
      break;

    case 'open_url':
      ws.send(JSON.stringify({
        type: 'open_url_response', requestId, status: 'success',
        tabId: 42, url: data.url,
      }));
      break;

    case 'close_tab':
      ws.send(JSON.stringify({
        type: 'close_tab_response', requestId, status: 'success',
        tabId: data.tabId,
      }));
      break;

    case 'get_html':
      ws.send(JSON.stringify({
        type: 'get_html_response', requestId, status: 'success',
        tabId: data.tabId, html: '<html><body>hello</body></html>',
      }));
      break;

    case 'execute_script':
      ws.send(JSON.stringify({
        type: 'execute_script_response', requestId, status: 'success',
        tabId: data.tabId, result: 'script_result_42',
      }));
      break;

    case 'inject_css':
      ws.send(JSON.stringify({
        type: 'inject_css_response', requestId, status: 'success',
        tabId: data.tabId,
      }));
      break;

    case 'get_cookies':
      ws.send(JSON.stringify({
        type: 'get_cookies_response', requestId, status: 'success',
        tabId: data.tabId, cookies: [{ name: 'sid', value: 'abc' }],
      }));
      break;

    default:
      ws.send(JSON.stringify({
        type: 'error', requestId, message: `Unknown action: ${action}`,
      }));
      break;
  }
}

function closeMockServer(wss) {
  return new Promise((resolve) => {
    for (const client of wss.clients) {
      client.terminate();
    }
    wss.close(resolve);
  });
}

// ── _normalizeWsUrl ─────────────────────────────────────────────────

describe('_normalizeWsUrl', () => {
  const bot = new BrowserAutomation('ws://localhost:18080', { logger: silentLogger });

  it('passes through ws:// URLs', () => {
    assert.equal(bot._normalizeWsUrl('ws://localhost:18080'), 'ws://localhost:18080');
  });

  it('passes through wss:// URLs', () => {
    assert.equal(bot._normalizeWsUrl('wss://example.com'), 'wss://example.com');
  });

  it('converts http:// to ws://', () => {
    assert.equal(bot._normalizeWsUrl('http://localhost:18080'), 'ws://localhost:18080');
  });

  it('converts https:// to wss://', () => {
    assert.equal(bot._normalizeWsUrl('https://example.com:443'), 'wss://example.com:443');
  });

  it('prepends ws:// to bare host:port', () => {
    assert.equal(bot._normalizeWsUrl('localhost:18080'), 'ws://localhost:18080');
  });

  bot.disconnect();
});

// ── _generateRequestId ──────────────────────────────────────────────

describe('_generateRequestId', () => {
  const bot = new BrowserAutomation('ws://localhost:18080', { logger: silentLogger });

  it('starts with "req_"', () => {
    assert.ok(bot._generateRequestId().startsWith('req_'));
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => bot._generateRequestId()));
    assert.equal(ids.size, 100);
  });

  bot.disconnect();
});

// ── _handleMessage ──────────────────────────────────────────────────

describe('_handleMessage', () => {
  let bot;
  beforeEach(() => {
    bot = new BrowserAutomation('ws://localhost:18080', { logger: silentLogger });
  });
  afterEach(() => bot.disconnect());

  it('resolves pending request on success', () => {
    let resolved = null;
    const pending = {
      resolve: (v) => { resolved = v; },
      reject: () => {},
      timeoutId: setTimeout(() => {}, 10000),
    };
    bot.pendingRequests.set('req-1', pending);

    bot._handleMessage(JSON.stringify({
      type: 'get_tabs_response', requestId: 'req-1', status: 'success',
      data: { tabs: [] },
    }));

    assert.notEqual(resolved, null);
    assert.equal(resolved.status, 'success');
    assert.equal(bot.pendingRequests.size, 0);
  });

  it('rejects pending request on status error', () => {
    let rejected = null;
    const pending = {
      resolve: () => {},
      reject: (e) => { rejected = e; },
      timeoutId: setTimeout(() => {}, 10000),
    };
    bot.pendingRequests.set('req-2', pending);

    bot._handleMessage(JSON.stringify({
      type: 'open_url_response', requestId: 'req-2', status: 'error',
      message: 'No browser extension connected',
    }));

    assert.ok(rejected instanceof Error);
    assert.ok(rejected.message.includes('No browser extension'));
    assert.equal(bot.pendingRequests.size, 0);
  });

  it('rejects pending request on type=error (unknown action)', () => {
    let rejected = null;
    const pending = {
      resolve: () => {},
      reject: (e) => { rejected = e; },
      timeoutId: setTimeout(() => {}, 10000),
    };
    bot.pendingRequests.set('req-3', pending);

    bot._handleMessage(JSON.stringify({
      type: 'error', requestId: 'req-3',
      message: 'Unknown action: bad_action',
    }));

    assert.ok(rejected instanceof Error);
    assert.ok(rejected.message.includes('Unknown action'));
  });

  it('ignores messages without matching requestId', () => {
    bot._handleMessage(JSON.stringify({
      type: 'get_tabs_response', requestId: 'nonexistent', status: 'success',
    }));
    assert.equal(bot.pendingRequests.size, 0);
  });

  it('ignores invalid JSON', () => {
    bot._handleMessage('not-json');
    // no throw
  });
});

// ── connection management (integration) ─────────────────────────────

describe('connect / disconnect', () => {
  let server, bot;

  before(async () => {
    server = await createMockServer();
  });
  after(async () => {
    if (bot) bot.disconnect();
    await closeMockServer(server.wss);
  });

  it('connects and receives clientId', async () => {
    bot = new BrowserAutomation(server.url, { logger: silentLogger });
    await bot.connect();
    assert.equal(bot._wsState, 'connected');
    assert.equal(bot._clientId, 'test-client-id');
  });

  it('connect() is idempotent when already connected', async () => {
    await bot.connect();
    assert.equal(bot._wsState, 'connected');
  });

  it('disconnect cleans up state', () => {
    bot.disconnect();
    assert.equal(bot._wsState, 'disconnected');
    assert.equal(bot._clientId, null);
    assert.equal(bot.ws, null);
  });
});

// ── business methods (integration) ──────────────────────────────────

describe('business methods', () => {
  let server, bot;

  before(async () => {
    server = await createMockServer();
    bot = new BrowserAutomation(server.url, {
      logger: silentLogger,
      requestInterval: 0,
    });
    await bot.connect();
  });

  after(async () => {
    bot.disconnect();
    await closeMockServer(server.wss);
  });

  it('getTabs() returns tabs and browsers', async () => {
    const result = await bot.getTabs();
    assert.equal(result.browsers.length, 1);
    assert.equal(result.tabs.length, 2);
    assert.equal(result.activeTabId, 1);
    assert.equal(result.browsers[0].browserName, 'firefox');
  });

  it('listClients() returns client list', async () => {
    const clients = await bot.listClients();
    assert.equal(clients.length, 2);
    assert.equal(clients[0].browserName, 'firefox');
    assert.equal(clients[1].browserName, 'chrome');
  });

  it('openUrl() returns tabId', async () => {
    const tabId = await bot.openUrl('https://test.com');
    assert.equal(tabId, 42);
  });

  it('closeTab() resolves without error', async () => {
    await bot.closeTab(1);
  });

  it('getTabHtml() returns HTML string', async () => {
    const html = await bot.getTabHtml(1);
    assert.equal(html, '<html><body>hello</body></html>');
  });

  it('executeScript() returns result', async () => {
    const result = await bot.executeScript(1, 'document.title');
    assert.equal(result, 'script_result_42');
  });

  it('executeScript() accepts timeout as number (backward compat)', async () => {
    const result = await bot.executeScript(1, '1+1', 30);
    assert.equal(result, 'script_result_42');
  });

  it('injectCss() resolves without error', async () => {
    await bot.injectCss(1, 'body { color: red }');
  });

  it('getCookies() returns cookies array', async () => {
    const cookies = await bot.getCookies(1);
    assert.equal(cookies.length, 1);
    assert.equal(cookies[0].name, 'sid');
    assert.equal(cookies[0].value, 'abc');
  });
});

// ── target parameter ────────────────────────────────────────────────

describe('target parameter', () => {
  let server, bot, lastReceivedMessage;

  before(async () => {
    server = await createMockServer((ws, data) => {
      lastReceivedMessage = data;
      defaultHandler(ws, data);
    });
    bot = new BrowserAutomation(server.url, {
      logger: silentLogger,
      requestInterval: 0,
    });
    await bot.connect();
  });

  after(async () => {
    bot.disconnect();
    await closeMockServer(server.wss);
  });

  it('sends target field when specified', async () => {
    await bot.openUrl('https://example.com', null, null, { target: 'firefox' });
    assert.equal(lastReceivedMessage.target, 'firefox');
  });

  it('omits target field when not specified', async () => {
    await bot.closeTab(1);
    assert.equal(lastReceivedMessage.target, undefined);
  });
});

// ── error handling ──────────────────────────────────────────────────

describe('error handling', () => {
  let server, bot;

  before(async () => {
    server = await createMockServer((ws, data) => {
      const action = data.action || data.type;
      if (action === 'fail_action') {
        ws.send(JSON.stringify({
          type: `${action}_response`, requestId: data.requestId,
          status: 'error', message: 'Something went wrong',
        }));
      } else if (action === 'unknown_boom') {
        ws.send(JSON.stringify({
          type: 'error', requestId: data.requestId,
          message: 'Unknown action: unknown_boom',
        }));
      } else {
        defaultHandler(ws, data);
      }
    });
    bot = new BrowserAutomation(server.url, {
      logger: silentLogger,
      requestInterval: 0,
    });
    await bot.connect();
  });

  after(async () => {
    bot.disconnect();
    await closeMockServer(server.wss);
  });

  it('rejects with Error on status=error response', async () => {
    await assert.rejects(
      () => bot._sendRequest('fail_action', {}),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('Something went wrong'));
        return true;
      },
    );
  });

  it('rejects with Error on type=error response (unknown action)', async () => {
    await assert.rejects(
      () => bot._sendRequest('unknown_boom', {}),
      (err) => {
        assert.ok(err.message.includes('Unknown action'));
        return true;
      },
    );
  });
});

// ── disconnect rejects pending ──────────────────────────────────────

describe('disconnect rejects pending requests', () => {
  let server, bot;

  before(async () => {
    server = await createMockServer((ws, data) => {
      // intentionally don't respond — simulate hung request
    });
    bot = new BrowserAutomation(server.url, {
      logger: silentLogger,
      requestInterval: 0,
      defaultTimeout: 30,
    });
    await bot.connect();
  });

  after(async () => {
    await closeMockServer(server.wss);
  });

  it('rejects pending requests when disconnect is called', async () => {
    const promise = bot._sendRequest('get_html', { tabId: 1 });

    // Wait for the async setup inside _sendRequest to register the pending request
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(bot.pendingRequests.size, 1);

    bot.disconnect();

    await assert.rejects(promise, (err) => {
      assert.ok(err.message.includes('主动关闭'));
      return true;
    });
    assert.equal(bot.pendingRequests.size, 0);
  });
});

// ── client timeout ──────────────────────────────────────────────────

describe('client-side timeout', () => {
  let server, bot;

  before(async () => {
    server = await createMockServer((ws, data) => {
      // never respond
    });
    bot = new BrowserAutomation(server.url, {
      logger: silentLogger,
      requestInterval: 0,
      defaultTimeout: 1,
    });
    await bot.connect();
  });

  after(async () => {
    bot.disconnect();
    await closeMockServer(server.wss);
  });

  it('rejects after timeout', async () => {
    await assert.rejects(
      () => bot._sendRequest('get_html', { tabId: 1 }),
      (err) => {
        assert.ok(err.message.includes('超时'));
        return true;
      },
    );
  });
});

// ── constructor defaults ────────────────────────────────────────────

describe('constructor', () => {
  it('uses default URL when none provided', () => {
    const bot = new BrowserAutomation(undefined, { logger: silentLogger });
    assert.equal(bot.serverUrl, 'ws://localhost:18080');
    bot.disconnect();
  });

  it('uses provided options', () => {
    const bot = new BrowserAutomation('ws://myhost:9999', {
      logger: silentLogger,
      requestInterval: 500,
      defaultTimeout: 120,
    });
    assert.equal(bot.serverUrl, 'ws://myhost:9999');
    assert.equal(bot.requestInterval, 500);
    assert.equal(bot.defaultTimeout, 120);
    bot.disconnect();
  });
});
