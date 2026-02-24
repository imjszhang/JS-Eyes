'use strict';

const crypto = require('crypto');
const { URL } = require('url');

const REQUEST_TIMEOUT_MS = 60000;

function generateId() {
  return crypto.randomUUID();
}

function send(socket, data) {
  if (socket.readyState === 1) {
    socket.send(JSON.stringify(data));
  }
}

// ── connection entry ────────────────────────────────────────────────

function handleConnection(socket, request, state) {
  const clientAddress = `${request.socket.remoteAddress}:${request.socket.remotePort}`;
  const url = new URL(request.url, `ws://${request.headers.host || 'localhost'}`);
  const clientType = url.searchParams.get('type') || 'extension';

  if (clientType === 'automation') {
    setupAutomationClient(socket, clientAddress, state);
  } else {
    setupExtensionClient(socket, clientAddress, state);
  }
}

// ── extension client ────────────────────────────────────────────────

function setupExtensionClient(socket, clientAddress, state) {
  const clientId = generateId();

  console.log(`[Extension] Connected: ${clientAddress} (${clientId})`);

  state.extensionClients.set(clientId, {
    socket,
    clientAddress,
    createdAt: Date.now(),
    lastActivity: Date.now(),
  });

  // Skip 30-second auth wait: tell extension auth succeeded immediately
  send(socket, {
    type: 'auth_result',
    success: true,
    sessionId: null,
    expiresIn: null,
    permissions: null,
  });

  socket.on('message', (raw) => {
    const conn = state.extensionClients.get(clientId);
    if (conn) conn.lastActivity = Date.now();
    handleExtensionMessage(raw, clientId, state);
  });

  socket.on('close', () => {
    console.log(`[Extension] Disconnected: ${clientAddress} (${clientId})`);
    state.extensionClients.delete(clientId);
  });

  socket.on('error', (err) => {
    console.error(`[Extension] Error ${clientId}: ${err.message}`);
    state.extensionClients.delete(clientId);
  });
}

// ── automation client ───────────────────────────────────────────────

function setupAutomationClient(socket, clientAddress, state) {
  const clientId = generateId();

  console.log(`[Automation] Connected: ${clientAddress} (${clientId})`);

  state.automationClients.set(clientId, {
    socket,
    clientAddress,
    createdAt: Date.now(),
    lastActivity: Date.now(),
  });

  send(socket, {
    type: 'connection_established',
    clientId,
    timestamp: new Date().toISOString(),
  });

  socket.on('message', (raw) => {
    const conn = state.automationClients.get(clientId);
    if (conn) conn.lastActivity = Date.now();
    handleAutomationMessage(raw, clientId, socket, state);
  });

  socket.on('close', () => {
    console.log(`[Automation] Disconnected: ${clientAddress} (${clientId})`);
    state.automationClients.delete(clientId);
  });

  socket.on('error', (err) => {
    console.error(`[Automation] Error ${clientId}: ${err.message}`);
    state.automationClients.delete(clientId);
  });
}

// ── extension message handling ──────────────────────────────────────

function handleExtensionMessage(raw, clientId, state) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }

  // Unwrap new protocol envelope: { type: 'request', action, payload }
  if (data.type === 'request') {
    const action = data.action;
    const payload = data.payload || {};
    data = { type: action, requestId: data.requestId || payload.requestId, ...payload };
  }
  if (data.type === 'notification') {
    const action = data.action;
    const payload = data.payload || {};
    data = { type: action, ...payload };
  }

  switch (data.type) {
    case 'ping': {
      const conn = state.extensionClients.get(clientId);
      if (conn) send(conn.socket, { type: 'pong', timestamp: new Date().toISOString() });
      return;
    }

    case 'init':
      console.log('[Extension] Init received');
      {
        const conn = state.extensionClients.get(clientId);
        if (conn) {
          send(conn.socket, {
            type: 'init_ack',
            status: 'ok',
            serverConfig: {
              request: { defaultTimeout: REQUEST_TIMEOUT_MS },
            },
            timestamp: new Date().toISOString(),
          });
        }
      }
      return;

    case 'data': {
      const tabs = data.tabs || data.payload?.tabs || [];
      const activeTabId = data.active_tab_id || data.payload?.active_tab_id;
      state.tabs = tabs;
      state.activeTabId = activeTabId || null;
      return;
    }

    case 'error':
      handleExtensionError(data, state);
      return;

    default:
      break;
  }

  // All remaining messages require a requestId
  if (!data.requestId) return;

  const requestId = data.requestId;

  switch (data.type) {
    case 'open_url_complete':
      resolveRequest(requestId, {
        status: 'success',
        type: 'open_url_complete',
        tabId: data.tabId,
        url: data.url,
        cookies: data.cookies || [],
        requestId,
      }, state);
      break;

    case 'close_tab_complete':
      resolveRequest(requestId, {
        status: 'success',
        type: 'close_tab_complete',
        tabId: data.tabId,
        requestId,
      }, state);
      break;

    case 'tab_html_complete':
      resolveRequest(requestId, {
        status: 'success',
        type: 'tab_html_complete',
        tabId: data.tabId,
        html: data.html,
        requestId,
      }, state);
      break;

    case 'execute_script_complete':
      resolveRequest(requestId, {
        status: 'success',
        type: 'execute_script_complete',
        tabId: data.tabId,
        result: data.result,
        requestId,
      }, state);
      break;

    case 'inject_css_complete':
      resolveRequest(requestId, {
        status: 'success',
        type: 'inject_css_complete',
        tabId: data.tabId,
        requestId,
      }, state);
      break;

    case 'get_cookies_complete':
      resolveRequest(requestId, {
        status: 'success',
        type: 'get_cookies_complete',
        tabId: data.tabId,
        url: data.url,
        cookies: data.cookies || [],
        requestId,
      }, state);
      break;

    case 'upload_file_to_tab_complete':
      resolveRequest(requestId, {
        status: 'success',
        type: 'upload_file_to_tab_complete',
        tabId: data.tabId,
        uploadedFiles: data.uploadedFiles || [],
        requestId,
      }, state);
      break;

    default:
      break;
  }
}

function handleExtensionError(data, state) {
  const requestId = data.requestId;
  const message = data.message || 'Unknown error';
  console.error(`[Extension] Error: ${message}` + (requestId ? ` (req: ${requestId})` : ''));

  if (requestId) {
    resolveRequest(requestId, {
      status: 'error',
      type: 'error',
      message,
      code: data.code || 'EXTENSION_ERROR',
      requestId,
    }, state);
  }
}

// ── automation message handling ─────────────────────────────────────

function handleAutomationMessage(raw, clientId, socket, state) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    send(socket, { type: 'error', message: 'Invalid JSON' });
    return;
  }

  const action = data.action || data.type;
  const requestId = data.requestId;

  switch (action) {
    case 'get_tabs':
      send(socket, {
        type: 'get_tabs_response',
        requestId,
        status: 'success',
        data: { tabs: state.tabs, activeTabId: state.activeTabId },
      });
      break;

    case 'open_url':
      forwardToExtension('open_url', data, socket, state, ['url', 'tabId', 'windowId']);
      break;

    case 'close_tab':
      forwardToExtension('close_tab', data, socket, state, ['tabId']);
      break;

    case 'get_html':
      forwardToExtension('get_html', data, socket, state, ['tabId']);
      break;

    case 'execute_script':
      forwardToExtension('execute_script', data, socket, state, ['tabId', 'code']);
      break;

    case 'inject_css':
      forwardToExtension('inject_css', data, socket, state, ['tabId', 'css']);
      break;

    case 'get_cookies':
      forwardToExtension('get_cookies', data, socket, state, ['tabId']);
      break;

    default:
      send(socket, { type: 'error', requestId, message: `Unknown action: ${action}` });
      break;
  }
}

// ── forward command to first available extension ────────────────────

function forwardToExtension(type, data, automationSocket, state, fields) {
  const requestId = data.requestId || generateId();

  const ext = pickExtension(state);
  if (!ext) {
    send(automationSocket, {
      type: `${type}_response`,
      requestId,
      status: 'error',
      message: 'No browser extension connected',
    });
    return;
  }

  const msg = { type, requestId };
  for (const f of fields) {
    if (data[f] !== undefined) msg[f] = data[f];
  }

  send(ext.socket, msg);
  registerPending(requestId, automationSocket, type, state);
}

function pickExtension(state) {
  for (const [, conn] of state.extensionClients) {
    if (conn.socket.readyState === 1) return conn;
  }
  return null;
}

// ── pending response management ─────────────────────────────────────

function registerPending(requestId, automationSocket, operationType, state) {
  const timeoutId = setTimeout(() => {
    const info = state.pendingResponses.get(requestId);
    if (!info) return;
    state.pendingResponses.delete(requestId);

    const timeoutResponse = {
      status: 'error',
      type: `${operationType}_timeout`,
      requestId,
      message: `Request timed out after ${REQUEST_TIMEOUT_MS}ms`,
    };

    send(info.socket, { type: `${operationType}_response`, requestId, ...timeoutResponse });
    state.callbackResponses.set(requestId, timeoutResponse);
  }, REQUEST_TIMEOUT_MS);

  state.pendingResponses.set(requestId, {
    socket: automationSocket,
    timeoutId,
    operationType,
    createdAt: Date.now(),
  });
}

function resolveRequest(requestId, responseData, state) {
  state.callbackResponses.set(requestId, responseData);

  const info = state.pendingResponses.get(requestId);
  if (info) {
    clearTimeout(info.timeoutId);
    state.pendingResponses.delete(requestId);

    const responseType = info.operationType
      ? `${info.operationType}_response`
      : responseData.type?.replace('_complete', '_response') || 'response';

    send(info.socket, { ...responseData, type: responseType, requestId });
  }
}

// ── periodic cleanup ────────────────────────────────────────────────

function startCleanup(state) {
  // Clean stale callback responses older than 5 minutes
  const RESPONSE_TTL = 5 * 60 * 1000;

  return setInterval(() => {
    const cutoff = Date.now() - RESPONSE_TTL;
    for (const [id, resp] of state.callbackResponses) {
      const ts = resp._storedAt || 0;
      if (ts < cutoff) state.callbackResponses.delete(id);
    }

    // Clean disconnected extension clients
    for (const [id, conn] of state.extensionClients) {
      if (conn.socket.readyState !== 1) state.extensionClients.delete(id);
    }
    for (const [id, conn] of state.automationClients) {
      if (conn.socket.readyState !== 1) state.automationClients.delete(id);
    }
  }, 30000);
}

// ── state factory ───────────────────────────────────────────────────

function createState() {
  return {
    tabs: [],
    activeTabId: null,
    extensionClients: new Map(),
    automationClients: new Map(),
    pendingResponses: new Map(),
    callbackResponses: new Map(),
  };
}

module.exports = {
  handleConnection,
  createState,
  startCleanup,
  REQUEST_TIMEOUT_MS,
};
