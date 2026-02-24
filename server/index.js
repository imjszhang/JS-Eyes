'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');
const { handleConnection, createState, startCleanup, getExtensionSummaries } = require('./ws-handler');

// ── server factory ──────────────────────────────────────────────────

function createServer(options = {}) {
  const port = options.port || 18080;
  const host = options.host || 'localhost';
  const logger = options.logger || console;

  const state = createState();
  let cleanupTimer = null;

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
          websocket: `ws://${host}:${port}`,
          endpoints: ['/api/browser/status', '/api/browser/tabs', '/api/browser/clients', '/api/browser/health'],
        });
        break;

      case '/api/browser/status': {
        const browsers = getExtensionSummaries(state);
        const totalTabs = browsers.reduce((sum, b) => sum + b.tabCount, 0);
        jsonResponse(res, 200, {
          status: 'success',
          data: {
            isRunning: true,
            uptime: Math.floor(process.uptime()),
            connections: {
              extensions: browsers.map(({ clientId, browserName, connectedAt, tabCount }) =>
                ({ clientId, browserName, connectedAt, tabCount })),
              automationClients: state.automationClients.size,
            },
            tabs: totalTabs,
            pendingRequests: state.pendingResponses.size,
          },
        });
        break;
      }

      case '/api/browser/tabs': {
        const browsers = getExtensionSummaries(state);
        const allTabs = browsers.flatMap((b) => b.tabs);
        const lastBrowser = browsers[browsers.length - 1];
        jsonResponse(res, 200, {
          status: 'success',
          browsers,
          tabs: allTabs,
          activeTabId: lastBrowser ? lastBrowser.activeTabId : null,
        });
        break;
      }

      case '/api/browser/clients': {
        const browsers = getExtensionSummaries(state);
        jsonResponse(res, 200, {
          status: 'success',
          clients: browsers,
        });
        break;
      }

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
            websocketAddress: `ws://${host}:${port}`,
            host,
            extensionPort: port,
          },
        });
        break;

      default:
        jsonResponse(res, 404, { status: 'error', message: 'Not found' });
        break;
    }
  }

  const httpServer = http.createServer(handleHttpRequest);
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (socket, request) => {
    handleConnection(socket, request, state);
  });

  wss.on('error', () => {});

  function start() {
    return new Promise((resolve, reject) => {
      cleanupTimer = startCleanup(state);

      httpServer.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`端口 ${port} 已被占用`));
        } else {
          reject(err);
        }
      });

      httpServer.listen(port, host, () => {
        logger.info(`[js-eyes-server] WebSocket: ws://${host}:${port}`);
        logger.info(`[js-eyes-server] HTTP API:  http://${host}:${port}`);
        resolve();
      });
    });
  }

  function stop() {
    return new Promise((resolve) => {
      logger.info('[js-eyes-server] Shutting down...');

      if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
      }

      for (const [, conn] of state.extensionClients) {
        try { conn.socket.close(1000, 'Server shutting down'); } catch {}
      }
      for (const [, conn] of state.automationClients) {
        try { conn.socket.close(1000, 'Server shutting down'); } catch {}
      }
      for (const [, info] of state.pendingResponses) {
        clearTimeout(info.timeoutId);
      }

      const forceTimer = setTimeout(resolve, 3000);

      wss.close(() => {
        httpServer.close(() => {
          clearTimeout(forceTimer);
          logger.info('[js-eyes-server] Server stopped.');
          resolve();
        });
      });
    });
  }

  return { start, stop, httpServer, wss, state };
}

module.exports = { createServer };

// ── direct execution ────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  function getArg(name, fallback) {
    const idx = args.indexOf(`--${name}`);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
  }

  const port = parseInt(getArg('port', '18080'), 10);
  const host = getArg('host', 'localhost');
  const server = createServer({ port, host });

  server.start().then(() => {
    console.log('');
    console.log('=== js-eyes server ===');
    console.log(`WebSocket: ws://${host}:${port}`);
    console.log(`HTTP API:  http://${host}:${port}`);
    console.log(`Status:    http://${host}:${port}/api/browser/status`);
    console.log(`Tabs:      http://${host}:${port}/api/browser/tabs`);
    console.log('');
    console.log(`请在扩展 Popup 中将服务器地址设置为: ws://${host}:${port}`);
    console.log('');
  }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });

  function shutdown() {
    server.stop().then(() => process.exit(0));
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
