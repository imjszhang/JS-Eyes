'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');
const { handleConnection, createState, startCleanup } = require('./ws-handler');

// ── CLI args ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}
const PORT = parseInt(getArg('port', '18080'), 10);
const HOST = getArg('host', 'localhost');

// ── shared state ────────────────────────────────────────────────────

const state = createState();

// ── HTTP server ─────────────────────────────────────────────────────

function jsonResponse(res, statusCode, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function handleHttpRequest(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    jsonResponse(res, 405, { status: 'error', message: 'Method not allowed' });
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  switch (path) {
    case '/':
      jsonResponse(res, 200, {
        name: 'js-eyes-server',
        version: '1.0.0',
        websocket: `ws://${HOST}:${PORT}`,
        endpoints: ['/api/browser/status', '/api/browser/tabs', '/api/browser/health'],
      });
      break;

    case '/api/browser/status':
      jsonResponse(res, 200, {
        status: 'success',
        data: {
          isRunning: true,
          uptime: Math.floor(process.uptime()),
          connections: {
            extensions: state.extensionClients.size,
            automationClients: state.automationClients.size,
          },
          tabs: state.tabs.length,
          pendingRequests: state.pendingResponses.size,
        },
      });
      break;

    case '/api/browser/tabs':
      jsonResponse(res, 200, {
        status: 'success',
        tabs: state.tabs,
        activeTabId: state.activeTabId,
      });
      break;

    case '/api/browser/health':
      jsonResponse(res, 200, {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        extensions: state.extensionClients.size,
      });
      break;

    case '/api/browser/config':
      jsonResponse(res, 200, {
        status: 'success',
        config: {
          websocketAddress: `ws://${HOST}:${PORT}`,
          host: HOST,
          extensionPort: PORT,
        },
      });
      break;

    default:
      jsonResponse(res, 404, { status: 'error', message: 'Not found' });
      break;
  }
}

const httpServer = http.createServer(handleHttpRequest);

// ── WebSocket server (shares the same HTTP server) ──────────────────

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (socket, request) => {
  handleConnection(socket, request, state);
});

wss.on('error', () => {
  // Errors are already handled by httpServer.on('error')
});

// ── start ───────────────────────────────────────────────────────────

const cleanupTimer = startCleanup(state);

httpServer.listen(PORT, HOST, () => {
  console.log('');
  console.log('=== js-eyes server ===');
  console.log(`WebSocket: ws://${HOST}:${PORT}`);
  console.log(`HTTP API:  http://${HOST}:${PORT}`);
  console.log(`Status:    http://${HOST}:${PORT}/api/browser/status`);
  console.log(`Tabs:      http://${HOST}:${PORT}/api/browser/tabs`);
  console.log('');
  console.log(`请在扩展 Popup 中将服务器地址设置为: ws://${HOST}:${PORT}`);
  console.log('');
});

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，请使用 --port <number> 指定其它端口`);
    process.exit(1);
  }
  console.error('Server error:', err.message);
});

// ── graceful shutdown ───────────────────────────────────────────────

function shutdown() {
  console.log('\nShutting down...');
  clearInterval(cleanupTimer);

  for (const [, conn] of state.extensionClients) {
    try { conn.socket.close(1000, 'Server shutting down'); } catch {}
  }
  for (const [, conn] of state.automationClients) {
    try { conn.socket.close(1000, 'Server shutting down'); } catch {}
  }
  for (const [, info] of state.pendingResponses) {
    clearTimeout(info.timeoutId);
  }

  wss.close(() => {
    httpServer.close(() => {
      console.log('Server stopped.');
      process.exit(0);
    });
  });

  setTimeout(() => process.exit(0), 3000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
