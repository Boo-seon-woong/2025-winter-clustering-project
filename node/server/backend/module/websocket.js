'use strict';

const WebSocket = require('ws');

function initWebsocket(server) {
  const wss = new WebSocket.Server({ server, path: '/ws' });
  const clients = new Set();

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => {
      clients.delete(ws);
    });
  });

  const pingInterval = setInterval(() => {
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }
  }, 30000);

  wss.on('close', () => {
    clearInterval(pingInterval);
  });

  function broadcast(event, payload) {
    const message = JSON.stringify({ event, payload });
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    }
  }

  return { broadcast };
}

module.exports = { initWebsocket };
