'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  createState,
  handleConnection,
  getExtensionSummaries,
  REQUEST_TIMEOUT_MS,
  _internal: {
    parseBrowserName,
    pickExtension,
    send,
    generateId,
    handleExtensionMessage,
    handleAutomationMessage,
    setupExtensionClient,
    setupAutomationClient,
    resolveRequest,
  },
} = require('../server/ws-handler');

// ── helpers ──────────────────────────────────────────────────────────

function createMockSocket(readyState = 1) {
  const messages = [];
  const handlers = {};
  return {
    readyState,
    send(data) { messages.push(JSON.parse(data)); },
    on(event, handler) {
      handlers[event] = handlers[event] || [];
      handlers[event].push(handler);
    },
    close() { this.readyState = 3; },
    _messages: messages,
    _handlers: handlers,
    _emit(event, ...args) {
      (handlers[event] || []).forEach((h) => h(...args));
    },
  };
}

function createMockRequest(query = '') {
  return {
    socket: { remoteAddress: '127.0.0.1', remotePort: 12345 },
    url: `/${query}`,
    headers: { host: 'localhost:18080' },
  };
}

function clearPendingTimers(state) {
  for (const [id, info] of state.pendingResponses) {
    clearTimeout(info.timeoutId);
  }
  state.pendingResponses.clear();
}

function addExtension(state, overrides = {}) {
  const id = overrides.clientId || generateId();
  const socket = overrides.socket || createMockSocket();
  state.extensionClients.set(id, {
    socket,
    clientAddress: '127.0.0.1:9999',
    createdAt: Date.now(),
    lastActivity: Date.now(),
    browserName: overrides.browserName || 'unknown',
    userAgent: overrides.userAgent || null,
    tabs: overrides.tabs || [],
    activeTabId: overrides.activeTabId || null,
  });
  return { id, socket, conn: state.extensionClients.get(id) };
}

// ── parseBrowserName ─────────────────────────────────────────────────

describe('parseBrowserName', () => {
  it('returns "firefox" for Firefox user agents', () => {
    assert.equal(parseBrowserName('Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/115.0'), 'firefox');
  });

  it('returns "firefox" for Gecko-only UA', () => {
    assert.equal(parseBrowserName('Mozilla/5.0 Gecko/20100101'), 'firefox');
  });

  it('returns "chrome" for Chrome user agents', () => {
    assert.equal(parseBrowserName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'), 'chrome');
  });

  it('returns "edge" for Edge user agents', () => {
    assert.equal(parseBrowserName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 Edg/120.0'), 'edge');
  });

  it('returns "safari" for Safari-only UA', () => {
    assert.equal(parseBrowserName('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15'), 'safari');
  });

  it('returns "unknown" for null/undefined', () => {
    assert.equal(parseBrowserName(null), 'unknown');
    assert.equal(parseBrowserName(undefined), 'unknown');
    assert.equal(parseBrowserName(''), 'unknown');
  });

  it('is case-insensitive', () => {
    assert.equal(parseBrowserName('FIREFOX/120'), 'firefox');
    assert.equal(parseBrowserName('CHROME/120'), 'chrome');
  });
});

// ── createState ──────────────────────────────────────────────────────

describe('createState', () => {
  it('returns object with required Maps', () => {
    const state = createState();
    assert.ok(state.extensionClients instanceof Map);
    assert.ok(state.automationClients instanceof Map);
    assert.ok(state.pendingResponses instanceof Map);
    assert.ok(state.callbackResponses instanceof Map);
  });

  it('all Maps are initially empty', () => {
    const state = createState();
    assert.equal(state.extensionClients.size, 0);
    assert.equal(state.automationClients.size, 0);
    assert.equal(state.pendingResponses.size, 0);
    assert.equal(state.callbackResponses.size, 0);
  });

  it('does not have global tabs or activeTabId', () => {
    const state = createState();
    assert.equal(state.tabs, undefined);
    assert.equal(state.activeTabId, undefined);
  });
});

// ── generateId ───────────────────────────────────────────────────────

describe('generateId', () => {
  it('returns a valid UUID string', () => {
    const id = generateId();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    assert.equal(ids.size, 100);
  });
});

// ── send ─────────────────────────────────────────────────────────────

describe('send', () => {
  it('sends JSON when socket is OPEN (readyState 1)', () => {
    const socket = createMockSocket(1);
    send(socket, { type: 'test', value: 42 });
    assert.equal(socket._messages.length, 1);
    assert.deepEqual(socket._messages[0], { type: 'test', value: 42 });
  });

  it('does not send when socket is not OPEN', () => {
    for (const state of [0, 2, 3]) {
      const socket = createMockSocket(state);
      send(socket, { type: 'test' });
      assert.equal(socket._messages.length, 0);
    }
  });
});

// ── getExtensionSummaries ────────────────────────────────────────────

describe('getExtensionSummaries', () => {
  let state;
  beforeEach(() => { state = createState(); });

  it('returns empty array when no extensions connected', () => {
    assert.deepEqual(getExtensionSummaries(state), []);
  });

  it('returns summaries for active extensions', () => {
    const tabs = [{ id: '1', url: 'https://a.com', title: 'A' }];
    addExtension(state, { browserName: 'chrome', tabs, activeTabId: '1' });

    const summaries = getExtensionSummaries(state);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].browserName, 'chrome');
    assert.deepEqual(summaries[0].tabs, tabs);
    assert.equal(summaries[0].activeTabId, '1');
    assert.equal(summaries[0].tabCount, 1);
    assert.ok(summaries[0].clientId);
    assert.ok(summaries[0].connectedAt);
  });

  it('skips disconnected extensions (readyState !== 1)', () => {
    addExtension(state, { socket: createMockSocket(3), browserName: 'firefox' });
    addExtension(state, { browserName: 'chrome' });

    const summaries = getExtensionSummaries(state);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].browserName, 'chrome');
  });

  it('returns multiple extensions', () => {
    addExtension(state, { browserName: 'firefox' });
    addExtension(state, { browserName: 'chrome' });

    const summaries = getExtensionSummaries(state);
    assert.equal(summaries.length, 2);
    const names = summaries.map((s) => s.browserName).sort();
    assert.deepEqual(names, ['chrome', 'firefox']);
  });
});

// ── pickExtension ────────────────────────────────────────────────────

describe('pickExtension', () => {
  let state;
  beforeEach(() => { state = createState(); });

  it('returns null when no extensions connected', () => {
    assert.equal(pickExtension(state, null), null);
  });

  it('returns first available extension when no target', () => {
    const ext = addExtension(state, { browserName: 'chrome' });
    const result = pickExtension(state, null);
    assert.equal(result.socket, ext.socket);
  });

  it('skips non-OPEN sockets when no target', () => {
    addExtension(state, { socket: createMockSocket(3) });
    const ext2 = addExtension(state, { browserName: 'firefox' });
    const result = pickExtension(state, null);
    assert.equal(result.socket, ext2.socket);
  });

  it('matches by exact clientId', () => {
    addExtension(state, { clientId: 'aaa', browserName: 'firefox' });
    const ext = addExtension(state, { clientId: 'bbb', browserName: 'chrome' });
    const result = pickExtension(state, 'bbb');
    assert.equal(result.socket, ext.socket);
  });

  it('returns null for non-matching clientId', () => {
    addExtension(state, { clientId: 'aaa', browserName: 'chrome' });
    assert.equal(pickExtension(state, 'nonexistent'), null);
  });

  it('matches by browserName (case-insensitive)', () => {
    addExtension(state, { browserName: 'firefox' });
    const ext = addExtension(state, { browserName: 'chrome' });
    const result = pickExtension(state, 'Chrome');
    assert.equal(result.socket, ext.socket);
  });

  it('returns null when browserName has no match', () => {
    addExtension(state, { browserName: 'chrome' });
    assert.equal(pickExtension(state, 'safari'), null);
  });

  it('skips non-OPEN sockets in targeted search', () => {
    addExtension(state, { socket: createMockSocket(3), browserName: 'chrome' });
    assert.equal(pickExtension(state, 'chrome'), null);
  });
});

// ── setupExtensionClient ─────────────────────────────────────────────

describe('setupExtensionClient', () => {
  let state;
  beforeEach(() => { state = createState(); });

  it('registers client in state and sends auth_result', () => {
    const socket = createMockSocket();
    setupExtensionClient(socket, '127.0.0.1:5000', state);

    assert.equal(state.extensionClients.size, 1);

    const [clientId, conn] = [...state.extensionClients.entries()][0];
    assert.equal(conn.socket, socket);
    assert.equal(conn.browserName, 'unknown');
    assert.deepEqual(conn.tabs, []);
    assert.equal(conn.activeTabId, null);

    assert.equal(socket._messages.length, 1);
    const msg = socket._messages[0];
    assert.equal(msg.type, 'auth_result');
    assert.equal(msg.success, true);
    assert.equal(msg.clientId, clientId);
  });

  it('removes client on socket close', () => {
    const socket = createMockSocket();
    setupExtensionClient(socket, '127.0.0.1:5000', state);
    assert.equal(state.extensionClients.size, 1);

    socket._emit('close');
    assert.equal(state.extensionClients.size, 0);
  });

  it('removes client on socket error', () => {
    const socket = createMockSocket();
    setupExtensionClient(socket, '127.0.0.1:5000', state);
    socket._emit('error', new Error('test'));
    assert.equal(state.extensionClients.size, 0);
  });
});

// ── setupAutomationClient ────────────────────────────────────────────

describe('setupAutomationClient', () => {
  let state;
  beforeEach(() => { state = createState(); });

  it('registers client and sends connection_established', () => {
    const socket = createMockSocket();
    setupAutomationClient(socket, '127.0.0.1:6000', state);

    assert.equal(state.automationClients.size, 1);

    const msg = socket._messages[0];
    assert.equal(msg.type, 'connection_established');
    assert.ok(msg.clientId);
    assert.ok(msg.timestamp);
  });

  it('removes client on close', () => {
    const socket = createMockSocket();
    setupAutomationClient(socket, '127.0.0.1:6000', state);
    socket._emit('close');
    assert.equal(state.automationClients.size, 0);
  });
});

// ── handleConnection ─────────────────────────────────────────────────

describe('handleConnection', () => {
  let state;
  beforeEach(() => { state = createState(); });

  it('routes to extension client by default', () => {
    const socket = createMockSocket();
    handleConnection(socket, createMockRequest(), state);
    assert.equal(state.extensionClients.size, 1);
    assert.equal(state.automationClients.size, 0);
  });

  it('routes to automation client when type=automation', () => {
    const socket = createMockSocket();
    handleConnection(socket, createMockRequest('?type=automation'), state);
    assert.equal(state.extensionClients.size, 0);
    assert.equal(state.automationClients.size, 1);
  });

  it('routes to extension client when type=extension', () => {
    const socket = createMockSocket();
    handleConnection(socket, createMockRequest('?type=extension'), state);
    assert.equal(state.extensionClients.size, 1);
  });
});

// ── handleExtensionMessage ───────────────────────────────────────────

describe('handleExtensionMessage', () => {
  let state, clientId, socket;
  beforeEach(() => {
    state = createState();
    socket = createMockSocket();
    const ext = addExtension(state, { socket });
    clientId = ext.id;
  });
  afterEach(() => clearPendingTimers(state));

  it('ignores invalid JSON', () => {
    handleExtensionMessage('not-json', clientId, state);
    assert.equal(socket._messages.length, 0);
  });

  it('handles ping → pong', () => {
    handleExtensionMessage(JSON.stringify({ type: 'ping' }), clientId, state);
    assert.equal(socket._messages.length, 1);
    assert.equal(socket._messages[0].type, 'pong');
    assert.ok(socket._messages[0].timestamp);
  });

  it('handles init — stores userAgent and browserName', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0.0.0';
    handleExtensionMessage(JSON.stringify({ type: 'init', userAgent: ua }), clientId, state);

    const conn = state.extensionClients.get(clientId);
    assert.equal(conn.userAgent, ua);
    assert.equal(conn.browserName, 'chrome');

    const ack = socket._messages[0];
    assert.equal(ack.type, 'init_ack');
    assert.equal(ack.status, 'ok');
    assert.equal(ack.clientId, clientId);
    assert.equal(ack.browserName, 'chrome');
  });

  it('handles init with notification envelope', () => {
    const msg = {
      type: 'notification',
      action: 'init',
      payload: { userAgent: 'Mozilla/5.0 Firefox/120.0' },
    };
    handleExtensionMessage(JSON.stringify(msg), clientId, state);

    const conn = state.extensionClients.get(clientId);
    assert.equal(conn.browserName, 'firefox');
  });

  it('handles data — stores tabs per connection', () => {
    const tabs = [{ id: '1', url: 'https://a.com' }, { id: '2', url: 'https://b.com' }];
    handleExtensionMessage(
      JSON.stringify({ type: 'data', tabs, active_tab_id: '2' }),
      clientId,
      state,
    );

    const conn = state.extensionClients.get(clientId);
    assert.deepEqual(conn.tabs, tabs);
    assert.equal(conn.activeTabId, '2');
  });

  it('handles data with notification envelope', () => {
    const msg = {
      type: 'notification',
      action: 'data',
      payload: { tabs: [{ id: '10' }], active_tab_id: '10' },
    };
    handleExtensionMessage(JSON.stringify(msg), clientId, state);

    const conn = state.extensionClients.get(clientId);
    assert.equal(conn.tabs.length, 1);
    assert.equal(conn.activeTabId, '10');
  });

  it('handles _complete messages — resolves pending request', () => {
    const autoSocket = createMockSocket();
    const reqId = 'req-123';

    state.pendingResponses.set(reqId, {
      socket: autoSocket,
      timeoutId: setTimeout(() => {}, 60000),
      operationType: 'open_url',
      createdAt: Date.now(),
    });

    handleExtensionMessage(
      JSON.stringify({ type: 'open_url_complete', requestId: reqId, tabId: '5', url: 'https://test.com' }),
      clientId,
      state,
    );

    assert.equal(state.pendingResponses.has(reqId), false);
    assert.equal(autoSocket._messages.length, 1);
    assert.equal(autoSocket._messages[0].type, 'open_url_response');
    assert.equal(autoSocket._messages[0].status, 'success');
  });

  it('handles error with requestId — resolves as error', () => {
    const autoSocket = createMockSocket();
    const reqId = 'req-err';

    state.pendingResponses.set(reqId, {
      socket: autoSocket,
      timeoutId: setTimeout(() => {}, 60000),
      operationType: 'execute_script',
      createdAt: Date.now(),
    });

    handleExtensionMessage(
      JSON.stringify({ type: 'error', requestId: reqId, message: 'Tab not found' }),
      clientId,
      state,
    );

    assert.equal(autoSocket._messages[0].status, 'error');
    assert.equal(autoSocket._messages[0].message, 'Tab not found');
  });
});

// ── handleAutomationMessage ──────────────────────────────────────────

describe('handleAutomationMessage', () => {
  let state, autoSocket;
  beforeEach(() => {
    state = createState();
    autoSocket = createMockSocket();
  });
  afterEach(() => clearPendingTimers(state));

  it('returns error on invalid JSON', () => {
    handleAutomationMessage('bad-json', 'auto-1', autoSocket, state);
    assert.equal(autoSocket._messages[0].type, 'error');
    assert.equal(autoSocket._messages[0].message, 'Invalid JSON');
  });

  it('returns error for unknown action', () => {
    handleAutomationMessage(
      JSON.stringify({ action: 'fly_to_moon', requestId: 'r1' }),
      'auto-1', autoSocket, state,
    );
    assert.equal(autoSocket._messages[0].type, 'error');
    assert.ok(autoSocket._messages[0].message.includes('fly_to_moon'));
  });

  describe('get_tabs', () => {
    it('returns empty when no extensions', () => {
      handleAutomationMessage(
        JSON.stringify({ action: 'get_tabs', requestId: 'r1' }),
        'auto-1', autoSocket, state,
      );

      const resp = autoSocket._messages[0];
      assert.equal(resp.type, 'get_tabs_response');
      assert.equal(resp.status, 'success');
      assert.deepEqual(resp.data.browsers, []);
      assert.deepEqual(resp.data.tabs, []);
      assert.equal(resp.data.activeTabId, null);
    });

    it('returns merged tabs from multiple browsers', () => {
      addExtension(state, {
        browserName: 'firefox',
        tabs: [{ id: '1' }, { id: '2' }],
        activeTabId: '1',
      });
      addExtension(state, {
        browserName: 'chrome',
        tabs: [{ id: '3' }],
        activeTabId: '3',
      });

      handleAutomationMessage(
        JSON.stringify({ action: 'get_tabs', requestId: 'r2' }),
        'auto-1', autoSocket, state,
      );

      const resp = autoSocket._messages[0];
      assert.equal(resp.data.browsers.length, 2);
      assert.equal(resp.data.tabs.length, 3);
    });
  });

  describe('list_clients', () => {
    it('returns connected extension clients', () => {
      addExtension(state, { browserName: 'chrome' });
      addExtension(state, { browserName: 'firefox' });

      handleAutomationMessage(
        JSON.stringify({ action: 'list_clients', requestId: 'r3' }),
        'auto-1', autoSocket, state,
      );

      const resp = autoSocket._messages[0];
      assert.equal(resp.type, 'list_clients_response');
      assert.equal(resp.data.clients.length, 2);
    });
  });

  describe('command forwarding with target', () => {
    it('forwards open_url to targeted browser', () => {
      const ffSocket = createMockSocket();
      const chromeSocket = createMockSocket();
      addExtension(state, { socket: ffSocket, browserName: 'firefox' });
      addExtension(state, { socket: chromeSocket, browserName: 'chrome' });

      handleAutomationMessage(
        JSON.stringify({
          action: 'open_url',
          url: 'https://test.com',
          target: 'chrome',
          requestId: 'r4',
        }),
        'auto-1', autoSocket, state,
      );

      assert.equal(ffSocket._messages.length, 0);
      assert.equal(chromeSocket._messages.length, 1);
      assert.equal(chromeSocket._messages[0].type, 'open_url');
      assert.equal(chromeSocket._messages[0].url, 'https://test.com');
    });

    it('returns error when target not found', () => {
      addExtension(state, { browserName: 'chrome' });

      handleAutomationMessage(
        JSON.stringify({
          action: 'open_url',
          url: 'https://test.com',
          target: 'safari',
          requestId: 'r5',
        }),
        'auto-1', autoSocket, state,
      );

      assert.equal(autoSocket._messages[0].status, 'error');
      assert.ok(autoSocket._messages[0].message.includes('safari'));
    });

    it('forwards to first available when no target', () => {
      const ext = addExtension(state, { browserName: 'chrome' });

      handleAutomationMessage(
        JSON.stringify({ action: 'execute_script', tabId: '1', code: 'return 1', requestId: 'r6' }),
        'auto-1', autoSocket, state,
      );

      assert.equal(ext.socket._messages.length, 1);
      assert.equal(ext.socket._messages[0].type, 'execute_script');
    });

    it('returns error when no extension connected', () => {
      handleAutomationMessage(
        JSON.stringify({ action: 'close_tab', tabId: '1', requestId: 'r7' }),
        'auto-1', autoSocket, state,
      );

      assert.equal(autoSocket._messages[0].status, 'error');
      assert.ok(autoSocket._messages[0].message.includes('No browser extension'));
    });
  });

  describe('all forwardable actions', () => {
    let extSocket;
    beforeEach(() => {
      extSocket = createMockSocket();
      addExtension(state, { socket: extSocket, browserName: 'chrome' });
    });

    for (const [action, fields] of [
      ['open_url', { url: 'https://x.com', tabId: '1' }],
      ['close_tab', { tabId: '2' }],
      ['get_html', { tabId: '3' }],
      ['execute_script', { tabId: '4', code: 'return 1' }],
      ['inject_css', { tabId: '5', css: 'body{color:red}' }],
      ['get_cookies', { tabId: '6' }],
    ]) {
      it(`forwards ${action} with correct fields`, () => {
        handleAutomationMessage(
          JSON.stringify({ action, requestId: `req-${action}`, ...fields }),
          'auto-1', autoSocket, state,
        );

        const msg = extSocket._messages[extSocket._messages.length - 1];
        assert.equal(msg.type, action);
        for (const [k, v] of Object.entries(fields)) {
          assert.equal(msg[k], v);
        }
      });
    }
  });
});

// ── resolveRequest ───────────────────────────────────────────────────

describe('resolveRequest', () => {
  let state;
  beforeEach(() => { state = createState(); });
  afterEach(() => clearPendingTimers(state));

  it('resolves pending request and sends response', () => {
    const socket = createMockSocket();
    const reqId = 'r-resolve';

    state.pendingResponses.set(reqId, {
      socket,
      timeoutId: setTimeout(() => {}, 60000),
      operationType: 'get_html',
      createdAt: Date.now(),
    });

    resolveRequest(reqId, { status: 'success', html: '<html/>' }, state);

    assert.equal(state.pendingResponses.has(reqId), false);
    assert.ok(state.callbackResponses.has(reqId));

    assert.equal(socket._messages.length, 1);
    assert.equal(socket._messages[0].type, 'get_html_response');
    assert.equal(socket._messages[0].status, 'success');
  });

  it('stores in callbackResponses even without pending request', () => {
    resolveRequest('orphan', { status: 'success' }, state);
    assert.ok(state.callbackResponses.has('orphan'));
  });
});

// ── multi-browser isolation (integration) ────────────────────────────

describe('multi-browser isolation', () => {
  let state;
  beforeEach(() => { state = createState(); });
  afterEach(() => clearPendingTimers(state));

  it('each extension maintains independent tab state', () => {
    const ff = addExtension(state, { browserName: 'firefox' });
    const ch = addExtension(state, { browserName: 'chrome' });

    handleExtensionMessage(
      JSON.stringify({ type: 'data', tabs: [{ id: 'ff-1' }], active_tab_id: 'ff-1' }),
      ff.id, state,
    );
    handleExtensionMessage(
      JSON.stringify({ type: 'data', tabs: [{ id: 'ch-1' }, { id: 'ch-2' }], active_tab_id: 'ch-2' }),
      ch.id, state,
    );

    const ffConn = state.extensionClients.get(ff.id);
    const chConn = state.extensionClients.get(ch.id);

    assert.deepEqual(ffConn.tabs, [{ id: 'ff-1' }]);
    assert.equal(ffConn.activeTabId, 'ff-1');
    assert.deepEqual(chConn.tabs, [{ id: 'ch-1' }, { id: 'ch-2' }]);
    assert.equal(chConn.activeTabId, 'ch-2');
  });

  it('commands are routed to the correct browser', () => {
    const ffSocket = createMockSocket();
    const chSocket = createMockSocket();
    addExtension(state, { socket: ffSocket, browserName: 'firefox' });
    addExtension(state, { socket: chSocket, browserName: 'chrome' });

    const autoSocket = createMockSocket();
    handleAutomationMessage(
      JSON.stringify({ action: 'get_html', tabId: '1', target: 'firefox', requestId: 'iso-1' }),
      'auto-1', autoSocket, state,
    );

    assert.equal(ffSocket._messages.length, 1);
    assert.equal(chSocket._messages.length, 0);
    assert.equal(ffSocket._messages[0].type, 'get_html');
  });

  it('get_tabs returns tabs from all browsers grouped', () => {
    addExtension(state, {
      browserName: 'firefox',
      tabs: [{ id: 'f1' }],
      activeTabId: 'f1',
    });
    addExtension(state, {
      browserName: 'chrome',
      tabs: [{ id: 'c1' }, { id: 'c2' }],
      activeTabId: 'c2',
    });

    const autoSocket = createMockSocket();
    handleAutomationMessage(
      JSON.stringify({ action: 'get_tabs', requestId: 'tabs-1' }),
      'auto-1', autoSocket, state,
    );

    const resp = autoSocket._messages[0];
    assert.equal(resp.data.browsers.length, 2);
    assert.equal(resp.data.tabs.length, 3);

    const ffBrowser = resp.data.browsers.find((b) => b.browserName === 'firefox');
    const chBrowser = resp.data.browsers.find((b) => b.browserName === 'chrome');
    assert.equal(ffBrowser.tabCount, 1);
    assert.equal(chBrowser.tabCount, 2);
  });
});
