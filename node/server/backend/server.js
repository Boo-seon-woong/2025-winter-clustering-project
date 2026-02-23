'use strict';

const path = require('path');
const http = require('http');

const { loadDotEnv } = require('./module/env');
loadDotEnv();

const { readBody, parseJson, sendJson, sendFile } = require('./module/http');
const users = require('./module/users');
const posts = require('./module/posts');
const { initWebsocket } = require('./module/websocket');

const SERVER_HOST = process.env.SERVER_HOST || '0.0.0.0';
const SERVER_PORT = Number(process.env.SERVER_PORT || 3000);
const NODE_ID = process.env.NODE_ID || 'node';
const KVS_PORT = Number(process.env.KVS_PORT || 4000);
const KVS_HOST = process.env.KVS_HOST || '127.0.0.1';

const SERVER_REQUEST_TIMEOUT_MS = Number.parseInt(process.env.SERVER_REQUEST_TIMEOUT_MS || '15000', 10);
const SERVER_OP_TIMEOUT_MS = Number.parseInt(process.env.SERVER_OP_TIMEOUT_MS || '8000', 10);
const SERVER_BODY_TIMEOUT_MS = Number.parseInt(process.env.SERVER_BODY_TIMEOUT_MS || '5000', 10);
const SERVER_SLOW_MS = Number.parseInt(process.env.SERVER_SLOW_MS || '500', 10);
const SERVER_LOG_ALL = parseBoolEnv(process.env.SERVER_LOG_ALL, false);
const AUTH_LOG_SUCCESS = parseBoolEnv(process.env.AUTH_LOG_SUCCESS, false);

const SERVER_MAX_INFLIGHT = Number.parseInt(process.env.SERVER_MAX_INFLIGHT || '600', 10);
const SERVER_MAX_QUEUE = Number.parseInt(process.env.SERVER_MAX_QUEUE || '2000', 10);
const SERVER_QUEUE_TIMEOUT_MS = Number.parseInt(process.env.SERVER_QUEUE_TIMEOUT_MS || '60', 10);

const PEER_BROADCAST_ENABLED = parseBoolEnv(process.env.PEER_BROADCAST_ENABLED, true);
const PEER_BROADCAST_WORKERS = Number.parseInt(process.env.PEER_BROADCAST_WORKERS || '2', 10);
const PEER_BROADCAST_QUEUE_MAX = Number.parseInt(process.env.PEER_BROADCAST_QUEUE_MAX || '2000', 10);
const PEER_BROADCAST_TIMEOUT_MS = Number.parseInt(process.env.PEER_BROADCAST_TIMEOUT_MS || '350', 10);

const FRONTEND_DIR = path.resolve(__dirname, '..', 'frontend');
const ASSETS_DIR = path.join(FRONTEND_DIR, 'assets');

let hub = { broadcast: () => {} };
let reqSeq = 0;

function clampPositiveInt(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function parseBoolEnv(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const s = String(value).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') {
    return true;
  }
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') {
    return false;
  }
  return fallback;
}

function createAdmissionController(maxInflight, maxQueue, queueTimeoutMs) {
  const state = {
    inflight: 0,
    queue: [],
    shedCount: 0,
    timeoutCount: 0
  };

  function createOverloadedError(message) {
    const err = new Error(message || 'server overloaded');
    err.code = 'overloaded';
    return err;
  }

  function drain() {
    while (state.inflight < maxInflight && state.queue.length > 0) {
      const ticket = state.queue.shift();
      if (ticket.timer) {
        clearTimeout(ticket.timer);
      }
      state.inflight += 1;
      ticket.resolve();
    }
  }

  async function enter() {
    if (state.inflight < maxInflight) {
      state.inflight += 1;
      return;
    }
    if (state.queue.length >= maxQueue) {
      state.shedCount += 1;
      throw createOverloadedError('server inflight limit');
    }

    await new Promise((resolve, reject) => {
      const ticket = {
        resolve,
        reject,
        timer: null
      };
      ticket.timer = setTimeout(() => {
        const idx = state.queue.indexOf(ticket);
        if (idx >= 0) {
          state.queue.splice(idx, 1);
        }
        state.timeoutCount += 1;
        reject(createOverloadedError('server queue timeout'));
      }, queueTimeoutMs);
      state.queue.push(ticket);
    });
  }

  function leave() {
    if (state.inflight > 0) {
      state.inflight -= 1;
    }
    drain();
  }

  function snapshot() {
    return {
      inflight: state.inflight,
      queued: state.queue.length,
      shed: state.shedCount,
      queue_timeout: state.timeoutCount,
      max_inflight: maxInflight,
      max_queue: maxQueue
    };
  }

  return { enter, leave, snapshot };
}

function parseClusterNodes(raw) {
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const at = entry.indexOf('@');
      if (at <= 0) {
        return null;
      }
      const id = entry.slice(0, at).trim();
      let hostPort = entry.slice(at + 1).trim();
      if (hostPort.startsWith('http://')) {
        hostPort = hostPort.slice(7);
      } else if (hostPort.startsWith('https://')) {
        hostPort = hostPort.slice(8);
      }
      const slash = hostPort.indexOf('/');
      if (slash >= 0) {
        hostPort = hostPort.slice(0, slash);
      }
      const colon = hostPort.lastIndexOf(':');
      if (colon <= 0) {
        return null;
      }
      const host = hostPort.slice(0, colon);
      const port = parseInt(hostPort.slice(colon + 1), 10);
      if (!host || !Number.isFinite(port)) {
        return null;
      }
      return { id, host, port };
    })
    .filter(Boolean);
}

function resolveServerPeers() {
  const peers = parseClusterNodes(process.env.CLUSTER_NODES || '');
  const delta = KVS_PORT - SERVER_PORT;
  return peers
    .map((peer) => ({ id: peer.id, host: peer.host, port: peer.port - delta }))
    .filter((peer) => peer.id !== NODE_ID && peer.port > 0);
}

function postJson(host, port, reqPath, payload, timeoutMs) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      host,
      port,
      path: reqPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (resp) => {
      resp.on('data', () => {});
      resp.on('end', () => resolve(resp.statusCode === 200));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.write(body);
    req.end();
  });
}

function createAsyncBroadcaster(peers) {
  const state = {
    queue: [],
    running: 0,
    dropped: 0,
    sent: 0
  };

  const enabled = PEER_BROADCAST_ENABLED && peers.length > 0;
  const queueMax = clampPositiveInt(PEER_BROADCAST_QUEUE_MAX, 2000);
  const workers = clampPositiveInt(PEER_BROADCAST_WORKERS, 2);
  const timeoutMs = clampPositiveInt(PEER_BROADCAST_TIMEOUT_MS, 350);

  async function runOne(payload) {
    await Promise.all(peers.map((peer) => {
      return postJson(peer.host, peer.port, '/internal/post_event', payload, timeoutMs);
    }));
    state.sent += 1;
  }

  function pump() {
    while (enabled && state.running < workers && state.queue.length > 0) {
      const payload = state.queue.shift();
      state.running += 1;
      Promise.resolve()
        .then(() => runOne(payload))
        .catch(() => {})
        .finally(() => {
          state.running -= 1;
          setImmediate(pump);
        });
    }
  }

  function enqueue(payload) {
    if (!enabled) {
      return true;
    }
    if (state.queue.length >= queueMax) {
      state.dropped += 1;
      return false;
    }
    state.queue.push(payload);
    pump();
    return true;
  }

  function snapshot() {
    return {
      enabled,
      peers: peers.length,
      queue: state.queue.length,
      running: state.running,
      dropped: state.dropped,
      sent: state.sent
    };
  }

  return { enqueue, snapshot };
}

function runWithTimeout(label, timeoutMs, promiseFactory) {
  const startedAt = Date.now();
  const effectiveTimeoutMs = clampPositiveInt(timeoutMs, 1000);

  return new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) {
        return;
      }
      finished = true;
      const err = new Error(`${label} timeout`);
      err.code = 'timeout';
      reject(err);
    }, effectiveTimeoutMs);

    Promise.resolve()
      .then(() => promiseFactory())
      .then((result) => {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timer);
        const elapsedMs = Date.now() - startedAt;
        if (elapsedMs >= clampPositiveInt(SERVER_SLOW_MS, 500)) {
          console.log(`[op:slow] label=${label} ms=${elapsedMs} timeout_ms=${effectiveTimeoutMs}`);
        }
        resolve(result);
      })
      .catch((err) => {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timer);
        const elapsedMs = Date.now() - startedAt;
        console.log(`[op:error] label=${label} ms=${elapsedMs} timeout_ms=${effectiveTimeoutMs} error="${(err && err.message) || 'error'}"`);
        reject(err);
      });
  });
}

function logAuth(pathname, email, status, message) {
  if (!AUTH_LOG_SUCCESS && Number(status || 0) < 400) {
    return;
  }
  const safeEmail = String(email || '').trim().toLowerCase();
  const msg = message ? ` msg="${message}"` : '';
  console.log(`[auth] route=${pathname} email=${safeEmail} status=${status} kvs=${KVS_HOST}:${KVS_PORT}${msg}`);
}

function servePage(res, file) {
  sendFile(res, path.join(FRONTEND_DIR, file));
}

function serveAsset(res, pathname) {
  const rel = pathname.replace('/assets/', '');
  const full = path.resolve(ASSETS_DIR, rel);
  if (!full.startsWith(ASSETS_DIR)) {
    res.statusCode = 403;
    res.end('forbidden');
    return;
  }
  sendFile(res, full);
}

function currentUser(req) {
  const ctx = users.getSession(req);
  if (!ctx) {
    return null;
  }
  return {
    token: ctx.token,
    user: {
      email: ctx.session.email,
      name: ctx.session.name || ''
    }
  };
}

const admission = createAdmissionController(
  clampPositiveInt(SERVER_MAX_INFLIGHT, 600),
  clampPositiveInt(SERVER_MAX_QUEUE, 2000),
  clampPositiveInt(SERVER_QUEUE_TIMEOUT_MS, 60)
);
const broadcaster = createAsyncBroadcaster(resolveServerPeers());

const server = http.createServer(async (req, res) => {
  const reqId = ++reqSeq;
  const reqStartedAt = Date.now();
  const reqTimeoutMs = clampPositiveInt(SERVER_REQUEST_TIMEOUT_MS, 15000);
  const client = `${req.socket.remoteAddress || '-'}:${req.socket.remotePort || '-'}`;
  let timeoutHandled = false;
  let admitted = false;

  function handleReqTimeout(source) {
    if (timeoutHandled) {
      return;
    }
    timeoutHandled = true;
    const elapsedMs = Date.now() - reqStartedAt;
    console.log(`[req:timeout] id=${reqId} source=${source} method=${req.method} path=${req.url} ms=${elapsedMs} timeout_ms=${reqTimeoutMs}`);
    if (!res.headersSent) {
      sendJson(res, 504, { ok: false, error: 'request timeout' });
      return;
    }
    res.destroy();
  }

  if (SERVER_LOG_ALL) {
    console.log(`[req:start] id=${reqId} method=${req.method} path=${req.url} client=${client}`);
  }
  req.setTimeout(reqTimeoutMs, () => handleReqTimeout('request'));
  res.setTimeout(reqTimeoutMs, () => handleReqTimeout('response'));
  req.on('aborted', () => {
    console.log(`[req:aborted] id=${reqId} method=${req.method} path=${req.url}`);
  });
  req.on('error', (err) => {
    console.log(`[req:error] id=${reqId} method=${req.method} path=${req.url} error="${err.message || 'error'}"`);
  });
  res.on('error', (err) => {
    console.log(`[res:error] id=${reqId} method=${req.method} path=${req.url} error="${err.message || 'error'}"`);
  });
  res.on('finish', () => {
    const elapsedMs = Date.now() - reqStartedAt;
    if (SERVER_LOG_ALL || elapsedMs >= clampPositiveInt(SERVER_SLOW_MS, 500) || res.statusCode >= 500) {
      console.log(`[req:end] id=${reqId} method=${req.method} path=${req.url} status=${res.statusCode} ms=${elapsedMs}`);
    }
  });
  res.on('close', () => {
    if (!res.writableEnded) {
      const elapsedMs = Date.now() - reqStartedAt;
      console.log(`[req:close] id=${reqId} method=${req.method} path=${req.url} ms=${elapsedMs}`);
    }
  });

  try {
    await admission.enter();
    admitted = true;
  } catch (_err) {
    sendJson(res, 503, { ok: false, error: 'server overloaded' });
    return;
  }

  try {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/healthz') {
      sendJson(res, 200, {
        ok: true,
        node_id: NODE_ID,
        admission: admission.snapshot(),
        peer_broadcast: broadcaster.snapshot()
      });
      return;
    }

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      servePage(res, 'index.html');
      return;
    }
    if (req.method === 'GET' && (pathname === '/register' || pathname === '/register.html')) {
      servePage(res, 'register.html');
      return;
    }
    if (req.method === 'GET' && (pathname === '/main' || pathname === '/main.html')) {
      servePage(res, 'main.html');
      return;
    }
    if (req.method === 'GET' && (pathname === '/new' || pathname === '/new.html')) {
      servePage(res, 'new.html');
      return;
    }
    if (req.method === 'GET' && pathname.startsWith('/post/')) {
      servePage(res, 'post.html');
      return;
    }
    if (req.method === 'GET' && pathname.startsWith('/assets/')) {
      serveAsset(res, pathname);
      return;
    }

    if (pathname === '/internal/post_event' && req.method === 'POST') {
      const body = parseJson(await runWithTimeout(
        'readBody:/internal/post_event',
        SERVER_BODY_TIMEOUT_MS,
        () => readBody(req)
      ));
      if (!body || !body.id || !body.title || !body.email || !body.created_at) {
        sendJson(res, 400, { ok: false, error: 'invalid post event' });
        return;
      }
      hub.broadcast('post:new', body);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/register' && req.method === 'POST') {
      const body = parseJson(await runWithTimeout(
        'readBody:/api/register',
        SERVER_BODY_TIMEOUT_MS,
        () => readBody(req)
      ));
      if (!body) {
        logAuth(pathname, '', 400, 'invalid json');
        sendJson(res, 400, { ok: false, error: 'invalid json' });
        return;
      }
      const email = String(body.email || '');
      try {
        const out = await runWithTimeout(
          'users.register',
          SERVER_OP_TIMEOUT_MS,
          () => users.register(email, String(body.name || ''), String(body.password || ''))
        );
        logAuth(pathname, email, 200, 'ok');
        sendJson(res, 200, { ok: true, token: out.token, user: out.user });
      } catch (err) {
        const status = err.code === 'exists' ? 409 : 400;
        logAuth(pathname, email, status, err.message || 'register failed');
        sendJson(res, status, { ok: false, error: err.message || 'register failed' });
      }
      return;
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      const body = parseJson(await runWithTimeout(
        'readBody:/api/login',
        SERVER_BODY_TIMEOUT_MS,
        () => readBody(req)
      ));
      if (!body) {
        logAuth(pathname, '', 400, 'invalid json');
        sendJson(res, 400, { ok: false, error: 'invalid json' });
        return;
      }
      const email = String(body.email || '');
      try {
        const out = await runWithTimeout(
          'users.login',
          SERVER_OP_TIMEOUT_MS,
          () => users.login(email, String(body.password || ''))
        );
        logAuth(pathname, email, 200, 'ok');
        sendJson(res, 200, { ok: true, token: out.token, user: out.user });
      } catch (err) {
        logAuth(pathname, email, 401, err.message || 'login failed');
        sendJson(res, 401, { ok: false, error: err.message || 'login failed' });
      }
      return;
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      const u = currentUser(req);
      if (u) {
        users.logout(u.token);
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/me' && req.method === 'GET') {
      const u = currentUser(req);
      if (!u) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      sendJson(res, 200, { ok: true, user: u.user });
      return;
    }

    if (pathname === '/api/posts' && req.method === 'POST') {
      const u = currentUser(req);
      if (!u) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      const body = parseJson(await runWithTimeout(
        'readBody:/api/posts:post',
        SERVER_BODY_TIMEOUT_MS,
        () => readBody(req)
      ));
      if (!body) {
        sendJson(res, 400, { ok: false, error: 'invalid json' });
        return;
      }
      const title = String(body.title || '').trim();
      const content = String(body.content || '').trim();
      if (!title || !content) {
        sendJson(res, 400, { ok: false, error: 'missing fields' });
        return;
      }
      const post = await runWithTimeout(
        'posts.createPost',
        SERVER_OP_TIMEOUT_MS,
        () => posts.createPost(u.user.email, title, content)
      );
      const postPayload = {
        id: post.id,
        title: post.title,
        email: post.email,
        name: post.name,
        created_at: post.created_at
      };
      hub.broadcast('post:new', postPayload);
      broadcaster.enqueue(postPayload);
      sendJson(res, 200, { ok: true, post });
      return;
    }

    if (pathname === '/api/posts' && req.method === 'GET') {
      const u = currentUser(req);
      if (!u) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      const scope = url.searchParams.get('scope') || 'all';
      const list = await runWithTimeout(
        'posts.listPosts',
        SERVER_OP_TIMEOUT_MS,
        () => posts.listPosts(scope, u.user.email)
      );
      sendJson(res, 200, { ok: true, posts: list });
      return;
    }

    if (pathname.startsWith('/api/posts/') && req.method === 'GET') {
      const u = currentUser(req);
      if (!u) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      const id = decodeURIComponent(pathname.slice('/api/posts/'.length));
      if (!id) {
        sendJson(res, 400, { ok: false, error: 'invalid id' });
        return;
      }
      try {
        const post = await runWithTimeout(
          'posts.getPost',
          SERVER_OP_TIMEOUT_MS,
          () => posts.getPost(id)
        );
        sendJson(res, 200, { ok: true, post });
      } catch (_err) {
        sendJson(res, 404, { ok: false, error: 'not found' });
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    const status = err && err.code === 'timeout' ? 504 : 502;
    if (!res.writableEnded) {
      sendJson(res, status, { ok: false, error: err.message || 'bad gateway' });
    }
  } finally {
    if (admitted) {
      admission.leave();
    }
  }
});

hub = initWebsocket(server);

server.listen(SERVER_PORT, SERVER_HOST, () => {
  console.log(`backend listening on http://${SERVER_HOST}:${SERVER_PORT}`);
  console.log(`[cluster] node_id=${NODE_ID} cluster_nodes="${process.env.CLUSTER_NODES || ''}" peers=${JSON.stringify(resolveServerPeers())}`);
});
