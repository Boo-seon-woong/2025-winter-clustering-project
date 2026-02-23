'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding'
]);

function parseIntOrDefault(value, fallback) {
  const n = parseInt(String(value || ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function clampPositiveInt(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function normalizeSameSite(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'strict') {
    return 'Strict';
  }
  if (normalized === 'none') {
    return 'None';
  }
  return 'Lax';
}

function splitConnectionTokens(value) {
  const raw = Array.isArray(value) ? value.join(',') : String(value || '');
  return raw
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

function loadDotEnv() {
  const explicit = process.env.ENV_PATH;
  const candidates = explicit
    ? [explicit]
    : [
        path.resolve(__dirname, '.env'),
        path.resolve(__dirname, '..', '.env'),
        path.resolve(process.cwd(), '.env')
      ];

  let envPath = '';
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      envPath = candidate;
      break;
    }
  }
  if (!envPath) {
    return;
  }

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    if (line.startsWith('export ')) {
      line = line.slice(7).trim();
    }
    const eq = line.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) {
      continue;
    }
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function parseNode(rawEntry, index) {
  const raw = String(rawEntry || '').trim();
  if (!raw) {
    return null;
  }

  let id = `node-${index + 1}`;
  let endpoint = raw;

  const at = raw.indexOf('@');
  if (at >= 0) {
    id = raw.slice(0, at).trim() || id;
    endpoint = raw.slice(at + 1).trim();
  }
  if (!endpoint) {
    return null;
  }

  if (!endpoint.startsWith('http://') && !endpoint.startsWith('https://')) {
    endpoint = `http://${endpoint}`;
  }

  try {
    const u = new URL(endpoint);
    if (u.protocol !== 'http:') {
      return null;
    }
    const port = parseIntOrDefault(u.port, 80);
    if (!u.hostname || port <= 0) {
      return null;
    }
    return { id, host: u.hostname, port };
  } catch (_err) {
    return null;
  }
}

function parseNodes(raw) {
  if (!raw) {
    return [];
  }
  const out = String(raw)
    .split(',')
    .map((entry, index) => parseNode(entry, index))
    .filter(Boolean);

  const dedup = [];
  const seen = new Set();
  for (const node of out) {
    const key = `${node.host}:${node.port}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    dedup.push(node);
  }
  return dedup;
}

function deriveServerNodesFromCluster() {
  const clusterNodes = parseNodes(process.env.CLUSTER_NODES || '');
  if (!clusterNodes.length) {
    return [];
  }

  const kvsPort = parseIntOrDefault(process.env.KVS_PORT, 4000);
  const serverPort = parseIntOrDefault(process.env.SERVER_PORT, 3000);
  const delta = kvsPort - serverPort;

  return clusterNodes
    .map((node) => ({ id: node.id, host: node.host, port: node.port - delta }))
    .filter((node) => node.port > 0);
}

function resolveUpstreamNodes() {
  const ingressNodes = parseNodes(process.env.INGRESS_NODES || '');
  if (ingressNodes.length) {
    return ingressNodes;
  }

  const serverClusterNodes = parseNodes(process.env.SERVER_CLUSTER_NODES || '');
  if (serverClusterNodes.length) {
    return serverClusterNodes;
  }

  return deriveServerNodesFromCluster();
}

function cloneHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function appendForwardedHeaders(headers, req) {
  const remote = req.socket.remoteAddress;
  if (remote) {
    const prev = headers['x-forwarded-for'];
    headers['x-forwarded-for'] = prev ? `${prev}, ${remote}` : remote;
  }
  headers['x-forwarded-proto'] = req.socket.encrypted ? 'https' : 'http';
  if (req.headers.host) {
    headers['x-forwarded-host'] = req.headers.host;
  }
}

function stripHopByHopHeaders(headers, keepUpgrade) {
  const connectionTokens = splitConnectionTokens(headers.connection);
  if (keepUpgrade) {
    const tokens = connectionTokens.filter((token) => token === 'upgrade');
    headers.connection = tokens.length ? tokens.join(', ') : 'Upgrade';
  } else {
    delete headers.connection;
  }

  for (const token of connectionTokens) {
    if (!keepUpgrade || token !== 'upgrade') {
      delete headers[token];
    }
  }

  for (const key of HOP_BY_HOP_HEADERS) {
    if (keepUpgrade && key === 'connection') {
      continue;
    }
    delete headers[key];
  }

  if (!keepUpgrade) {
    delete headers.upgrade;
  }
}

function sanitizeUpstreamResponseHeaders(headers) {
  const out = cloneHeaders(headers);
  stripHopByHopHeaders(out, false);
  return out;
}

function parseCookies(rawHeader) {
  const out = {};
  const raw = Array.isArray(rawHeader) ? rawHeader.join(';') : String(rawHeader || '');
  if (!raw) {
    return out;
  }
  const pairs = raw.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx <= 0) {
      continue;
    }
    const key = pair.slice(0, idx).trim();
    if (!key) {
      continue;
    }
    const value = pair.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch (_err) {
      out[key] = value;
    }
  }
  return out;
}

function extractBearerToken(authorization) {
  const raw = Array.isArray(authorization) ? authorization.join(',') : String(authorization || '');
  if (!raw.startsWith('Bearer ')) {
    return '';
  }
  return raw.slice(7).trim();
}

function hashToIndex(raw, length) {
  let hash = 2166136261;
  const text = String(raw || '');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % length;
}

function createAffinityCookieHeader(state, affinityValue) {
  const parts = [
    `${state.affinityCookieName}=${encodeURIComponent(affinityValue)}`,
    'Path=/',
    `Max-Age=${state.affinityCookieMaxAgeSec}`,
    'HttpOnly',
    `SameSite=${state.affinityCookieSameSite}`
  ];
  if (state.affinityCookieSecure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

function appendSetCookieHeader(headers, cookieHeader) {
  if (!cookieHeader) {
    return;
  }
  const current = headers['set-cookie'];
  if (!current) {
    headers['set-cookie'] = [cookieHeader];
    return;
  }
  if (Array.isArray(current)) {
    headers['set-cookie'] = [...current, cookieHeader];
    return;
  }
  headers['set-cookie'] = [current, cookieHeader];
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    let finished = false;

    req.on('data', (chunk) => {
      if (finished) {
        return;
      }
      total += chunk.length;
      if (total > limitBytes) {
        finished = true;
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (finished) {
        return;
      }
      finished = true;
      resolve(Buffer.concat(chunks));
    });

    req.on('error', (err) => {
      if (finished) {
        return;
      }
      finished = true;
      reject(err);
    });
  });
}

function writeJson(res, statusCode, payload) {
  if (res.writableEnded) {
    return;
  }
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function createProxyRequestHeaders(req, node, bodyLength) {
  const headers = cloneHeaders(req.headers);
  stripHopByHopHeaders(headers, false);
  headers.host = `${node.host}:${node.port}`;
  appendForwardedHeaders(headers, req);
  headers['content-length'] = String(bodyLength);
  return headers;
}

function createUpgradeRequestText(req, node) {
  const headers = cloneHeaders(req.headers);
  stripHopByHopHeaders(headers, true);
  headers.host = `${node.host}:${node.port}`;
  appendForwardedHeaders(headers, req);

  const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        lines.push(`${key}: ${item}`);
      }
      continue;
    }
    lines.push(`${key}: ${value}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}

function createAdmissionController(maxInflight, maxQueue, queueTimeoutMs) {
  const state = {
    inflight: 0,
    queue: [],
    shedCount: 0,
    timeoutCount: 0
  };

  function createOverloadedError(message) {
    const err = new Error(message || 'ingress overloaded');
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
      throw createOverloadedError('ingress inflight limit');
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
        reject(createOverloadedError('ingress queue timeout'));
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

function decorateNodes(nodes) {
  return nodes.map((node) => ({
    ...node,
    inflight: 0,
    consecutiveFailures: 0,
    circuitOpenUntil: 0,
    totalRequests: 0,
    totalFailures: 0
  }));
}

function isCircuitOpen(node, nowMs) {
  return node.circuitOpenUntil > nowMs;
}

function markNodeSuccess(node) {
  node.consecutiveFailures = 0;
  node.circuitOpenUntil = 0;
}

function markNodeFailure(node, state) {
  node.totalFailures += 1;
  node.consecutiveFailures += 1;
  if (node.consecutiveFailures >= state.cbFailureThreshold) {
    node.circuitOpenUntil = Date.now() + state.cbCooldownMs;
    node.consecutiveFailures = 0;
  }
}

function sortIndicesByLoad(indices, state) {
  const ordered = [...indices];
  const pivot = state.pickCounter % state.nodes.length;
  state.pickCounter = (state.pickCounter + 1) % Math.max(1, state.nodes.length);
  ordered.sort((a, b) => {
    const na = state.nodes[a];
    const nb = state.nodes[b];
    if (na.inflight !== nb.inflight) {
      return na.inflight - nb.inflight;
    }
    const da = (a - pivot + state.nodes.length) % state.nodes.length;
    const db = (b - pivot + state.nodes.length) % state.nodes.length;
    return da - db;
  });
  return ordered;
}

function preferredNodeIndex(req, state) {
  if (!state.stickyEnabled) {
    return -1;
  }

  const cookies = parseCookies(req.headers.cookie);
  const fromCookie = String(cookies[state.affinityCookieName] || '').trim();
  if (fromCookie) {
    const idx = state.nodes.findIndex((node) => node.id === fromCookie);
    if (idx >= 0) {
      return idx;
    }
  }

  const token = extractBearerToken(req.headers.authorization);
  if (token) {
    return hashToIndex(`token:${token}`, state.nodes.length);
  }

  const remoteAddress = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '';
  if (remoteAddress) {
    return hashToIndex(`ip:${remoteAddress}`, state.nodes.length);
  }

  return -1;
}

function buildAttemptOrder(req, state) {
  const now = Date.now();
  const all = state.nodes.map((_node, index) => index);
  const healthy = all.filter((index) => !isCircuitOpen(state.nodes[index], now));
  const base = healthy.length > 0 ? healthy : all;
  const sorted = sortIndicesByLoad(base, state);
  const preferred = preferredNodeIndex(req, state);
  if (preferred >= 0) {
    const idx = sorted.indexOf(preferred);
    if (idx > 0) {
      sorted.splice(idx, 1);
      sorted.unshift(preferred);
    } else if (idx < 0) {
      sorted.unshift(preferred);
    }
  }

  const dedup = [];
  const seen = new Set();
  for (const index of sorted.concat(all)) {
    if (index < 0 || index >= state.nodes.length || seen.has(index)) {
      continue;
    }
    seen.add(index);
    dedup.push(index);
  }
  return dedup;
}

function computeAffinityCookieForAttempt(req, state, node, attempt, preferredIndex) {
  if (!state.stickyEnabled || !state.affinityCookieEnabled) {
    return '';
  }

  const cookies = parseCookies(req.headers.cookie);
  const hasCookie = !!cookies[state.affinityCookieName];
  if (attempt === 0) {
    if (hasCookie) {
      return '';
    }
    if (preferredIndex < 0) {
      return createAffinityCookieHeader(state, node.id);
    }
    return '';
  }
  return createAffinityCookieHeader(state, node.id);
}

function proxyHttpOnce(req, res, body, node, state, setCookieHeader) {
  return new Promise((resolve) => {
    let settled = false;
    let markedLoad = false;

    function finish(result) {
      if (settled) {
        return;
      }
      settled = true;
      if (markedLoad) {
        node.inflight = Math.max(0, node.inflight - 1);
      }
      resolve(result);
    }

    node.inflight += 1;
    node.totalRequests += 1;
    markedLoad = true;

    const upstreamReq = http.request(
      {
        hostname: node.host,
        port: node.port,
        method: req.method,
        path: req.url,
        agent: state.upstreamAgent,
        headers: createProxyRequestHeaders(req, node, body.length)
      },
      (upstreamRes) => {
        markNodeSuccess(node);
        finish({ ok: true, node });
        if (res.writableEnded) {
          upstreamRes.resume();
          return;
        }
        const responseHeaders = sanitizeUpstreamResponseHeaders(upstreamRes.headers);
        appendSetCookieHeader(responseHeaders, setCookieHeader);
        res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
        upstreamRes.pipe(res);
      }
    );

    upstreamReq.setTimeout(state.upstreamTimeoutMs, () => {
      const err = new Error('upstream timeout');
      err.code = 'upstream_timeout';
      upstreamReq.destroy(err);
    });

    upstreamReq.on('error', (err) => {
      markNodeFailure(node, state);
      finish({ ok: false, node, error: err });
    });

    if (body.length > 0) {
      upstreamReq.write(body);
    }
    upstreamReq.end();
  });
}

async function proxyHttp(req, res, state) {
  let body;
  try {
    body = await readBody(req, state.maxBodyBytes);
  } catch (err) {
    const status = Number.isFinite(err.statusCode) ? err.statusCode : 400;
    writeJson(res, status, { ok: false, error: err.message || 'invalid request' });
    return;
  }

  const order = buildAttemptOrder(req, state);
  const preferred = preferredNodeIndex(req, state);
  let lastError = null;

  for (let attempt = 0; attempt < order.length; attempt += 1) {
    if (res.writableEnded) {
      return;
    }

    const node = state.nodes[order[attempt]];
    const setCookieHeader = computeAffinityCookieForAttempt(req, state, node, attempt, preferred);
    const result = await proxyHttpOnce(req, res, body, node, state, setCookieHeader);
    if (result.ok) {
      return;
    }
    lastError = result.error || new Error('upstream connect failed');
  }

  writeJson(res, 502, {
    ok: false,
    error: `all upstream nodes failed: ${lastError ? lastError.message : 'unknown'}`
  });
}

function writeUpgradeFailure(clientSocket) {
  if (clientSocket.destroyed) {
    return;
  }
  clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
  clientSocket.destroy();
}

function proxyUpgrade(req, clientSocket, head, state) {
  const order = buildAttemptOrder(req, state);
  let attempt = 0;
  let currentUpstream = null;

  const closeCurrentUpstream = () => {
    if (currentUpstream && !currentUpstream.destroyed) {
      currentUpstream.destroy();
    }
  };

  clientSocket.once('close', closeCurrentUpstream);
  clientSocket.once('error', closeCurrentUpstream);

  const tryNext = () => {
    if (clientSocket.destroyed) {
      return;
    }
    if (attempt >= order.length) {
      writeUpgradeFailure(clientSocket);
      return;
    }

    const node = state.nodes[order[attempt]];
    attempt += 1;

    const upstreamSocket = net.connect(node.port, node.host);
    currentUpstream = upstreamSocket;
    node.inflight += 1;
    node.totalRequests += 1;

    let relayed = false;
    let finished = false;

    const finalize = () => {
      if (finished) {
        return;
      }
      finished = true;
      node.inflight = Math.max(0, node.inflight - 1);
    };

    const retry = (err) => {
      if (relayed || finished) {
        return;
      }
      finalize();
      markNodeFailure(node, state);
      upstreamSocket.destroy(err);
      tryNext();
    };

    upstreamSocket.setTimeout(state.upstreamTimeoutMs);

    upstreamSocket.once('connect', () => {
      upstreamSocket.setTimeout(0);
      const requestText = createUpgradeRequestText(req, node);
      upstreamSocket.write(requestText);
      if (head && head.length > 0) {
        upstreamSocket.write(head);
      }
    });

    upstreamSocket.once('data', (chunk) => {
      relayed = true;
      finalize();
      markNodeSuccess(node);
      clientSocket.write(chunk);
      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);
    });

    upstreamSocket.once('timeout', () => retry(new Error('upstream timeout')));
    upstreamSocket.once('error', retry);
    upstreamSocket.once('close', () => {
      if (!relayed) {
        retry(new Error('upstream closed'));
      }
    });
  };

  tryNext();
}

function buildStateFromEnv() {
  loadDotEnv();

  const rawNodes = resolveUpstreamNodes();
  if (!rawNodes.length) {
    throw new Error('No upstream nodes. Set INGRESS_NODES, SERVER_CLUSTER_NODES, or CLUSTER_NODES.');
  }

  const maxInflight = clampPositiveInt(parseIntOrDefault(process.env.INGRESS_MAX_INFLIGHT, 1200), 1200);
  const maxQueue = clampPositiveInt(parseIntOrDefault(process.env.INGRESS_MAX_QUEUE, 2400), 2400);
  const queueTimeoutMs = clampPositiveInt(parseIntOrDefault(process.env.INGRESS_QUEUE_TIMEOUT_MS, 60), 60);

  const state = {
    host: process.env.INGRESS_HOST || '0.0.0.0',
    port: parseIntOrDefault(process.env.INGRESS_PORT, 8080),
    upstreamTimeoutMs: clampPositiveInt(parseIntOrDefault(process.env.INGRESS_UPSTREAM_TIMEOUT_MS, 1500), 1500),
    maxBodyBytes: clampPositiveInt(parseIntOrDefault(process.env.INGRESS_MAX_BODY_BYTES, 2 * 1024 * 1024), 2 * 1024 * 1024),
    stickyEnabled: parseBool(process.env.INGRESS_STICKY_ENABLED, false),
    affinityCookieEnabled: parseBool(process.env.INGRESS_AFFINITY_COOKIE_ENABLED, false),
    affinityCookieName: process.env.INGRESS_AFFINITY_COOKIE || 'RDB_INGRESS_AFFINITY',
    affinityCookieMaxAgeSec: parseIntOrDefault(process.env.INGRESS_AFFINITY_MAX_AGE_SEC, 7 * 24 * 60 * 60),
    affinityCookieSameSite: normalizeSameSite(process.env.INGRESS_AFFINITY_SAMESITE || 'Lax'),
    affinityCookieSecure: parseBool(process.env.INGRESS_AFFINITY_SECURE, false),
    cbFailureThreshold: clampPositiveInt(parseIntOrDefault(process.env.INGRESS_CB_FAILURE_THRESHOLD, 6), 6),
    cbCooldownMs: clampPositiveInt(parseIntOrDefault(process.env.INGRESS_CB_COOLDOWN_MS, 800), 800),
    nodes: decorateNodes(rawNodes),
    pickCounter: 0,
    admission: createAdmissionController(maxInflight, maxQueue, queueTimeoutMs)
  };

  state.upstreamAgent = new http.Agent({
    keepAlive: parseBool(process.env.INGRESS_KEEP_ALIVE, true),
    keepAliveMsecs: clampPositiveInt(parseIntOrDefault(process.env.INGRESS_KEEP_ALIVE_MSECS, 1000), 1000),
    maxSockets: clampPositiveInt(parseIntOrDefault(process.env.INGRESS_MAX_SOCKETS, 4096), 4096),
    maxFreeSockets: clampPositiveInt(parseIntOrDefault(process.env.INGRESS_MAX_FREE_SOCKETS, 512), 512)
  });

  return state;
}

function createIngressServerFromEnv() {
  const state = buildStateFromEnv();

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      writeJson(res, 200, {
        ok: true,
        admission: state.admission.snapshot(),
        nodes: state.nodes.map((node) => ({
          id: node.id,
          host: node.host,
          port: node.port,
          inflight: node.inflight,
          circuit_open: isCircuitOpen(node, Date.now()),
          total_requests: node.totalRequests,
          total_failures: node.totalFailures
        }))
      });
      return;
    }

    let admitted = false;
    try {
      await state.admission.enter();
      admitted = true;
    } catch (_err) {
      writeJson(res, 503, { ok: false, error: 'ingress overloaded' });
      return;
    }

    try {
      await proxyHttp(req, res, state);
    } catch (err) {
      writeJson(res, 502, { ok: false, error: err.message || 'bad gateway' });
    } finally {
      if (admitted) {
        state.admission.leave();
      }
    }
  });

  server.on('upgrade', (req, socket, head) => {
    proxyUpgrade(req, socket, head, state);
  });

  server.on('error', (err) => {
    console.error(`Ingress failed: ${err.message}`);
    process.exit(1);
  });

  return { server, state };
}

function startFromEnv() {
  const { server, state } = createIngressServerFromEnv();
  server.listen(state.port, state.host, () => {
    console.log(`Ingress listening on http://${state.host}:${state.port}`);
    console.log(`Upstreams: ${state.nodes.map((n) => `${n.id}@${n.host}:${n.port}`).join(', ')}`);
    console.log(`Sticky: ${state.stickyEnabled ? 'enabled' : 'disabled'} (cookie: ${state.affinityCookieName})`);
  });
}

if (require.main === module) {
  startFromEnv();
}

module.exports = {
  createIngressServerFromEnv,
  deriveServerNodesFromCluster,
  parseNodes,
  resolveUpstreamNodes,
  startFromEnv
};
