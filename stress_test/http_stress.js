'use strict';

const cluster = require('cluster');
const os = require('os');
const http = require('http');
const https = require('https');
const { loadDotEnv } = require('./load_env');

loadDotEnv();

function envInt(name, fallback) {
  const v = Number.parseInt(process.env[name] || String(fallback), 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') {
    return fallback;
  }
  const s = String(raw).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return fallback;
}

const TARGET = process.env.TARGET || 'http://127.0.0.1:8080/healthz';
const METHOD = (process.env.METHOD || 'GET').toUpperCase();
const DURATION_SEC = envInt('DURATION_SEC', 60);
const CONCURRENCY_PER_WORKER = envInt('CONCURRENCY_PER_WORKER', 256);
const WORKERS = envInt('WORKERS', Math.max(1, (os.availableParallelism ? os.availableParallelism() : os.cpus().length) - 1));
const REQUEST_TIMEOUT_MS = envInt('REQUEST_TIMEOUT_MS', 3000);
const MAX_SOCKETS_PER_WORKER = envInt('MAX_SOCKETS_PER_WORKER', Math.max(CONCURRENCY_PER_WORKER * 2, 512));
const KEEP_ALIVE = envBool('KEEP_ALIVE', true);
const BODY = process.env.BODY || '';
const PRINT_INTERVAL_MS = envInt('PRINT_INTERVAL_MS', 1000);

function parseHeaders() {
  const out = {};
  const raw = process.env.HEADERS || '';
  if (!raw) {
    return out;
  }
  // Example: "Authorization:Bearer abc;X-Foo:bar"
  raw.split(';').map((s) => s.trim()).filter(Boolean).forEach((entry) => {
    const idx = entry.indexOf(':');
    if (idx <= 0) return;
    const key = entry.slice(0, idx).trim();
    const value = entry.slice(idx + 1).trim();
    if (!key) return;
    out[key] = value;
  });
  return out;
}

const HEADERS = parseHeaders();
if (BODY && !HEADERS['Content-Type']) {
  HEADERS['Content-Type'] = 'application/json';
}
if (BODY) {
  HEADERS['Content-Length'] = Buffer.byteLength(BODY);
}

if (cluster.isPrimary) {
  const startedAt = Date.now();
  const endAt = startedAt + DURATION_SEC * 1000;
  const totals = {
    sent: 0,
    ok: 0,
    failed: 0,
    timeout: 0,
    status2xx: 0,
    status3xx: 0,
    status4xx: 0,
    status5xx: 0
  };

  const workers = [];
  for (let i = 0; i < WORKERS; i += 1) {
    const w = cluster.fork();
    workers.push(w);
    w.on('message', (msg) => {
      if (!msg || msg.type !== 'stats') return;
      totals.sent += msg.sent || 0;
      totals.ok += msg.ok || 0;
      totals.failed += msg.failed || 0;
      totals.timeout += msg.timeout || 0;
      totals.status2xx += msg.status2xx || 0;
      totals.status3xx += msg.status3xx || 0;
      totals.status4xx += msg.status4xx || 0;
      totals.status5xx += msg.status5xx || 0;
    });
  }

  let prevSent = 0;
  const ticker = setInterval(() => {
    const elapsedSec = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
    const deltaSent = totals.sent - prevSent;
    prevSent = totals.sent;
    const instRps = Math.floor(deltaSent / (PRINT_INTERVAL_MS / 1000));
    const avgRps = Math.floor(totals.sent / elapsedSec);
    process.stdout.write(
      `t=${elapsedSec}s sent=${totals.sent} ok=${totals.ok} fail=${totals.failed} timeout=${totals.timeout} rps=${instRps} avg_rps=${avgRps}\n`
    );
  }, PRINT_INTERVAL_MS);

  setTimeout(() => {
    clearInterval(ticker);
    for (const w of workers) {
      w.send({ type: 'stop' });
    }
    setTimeout(() => {
      const elapsed = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
      const okRate = totals.sent > 0 ? ((totals.ok / totals.sent) * 100).toFixed(2) : '0.00';
      process.stdout.write('\n=== summary ===\n');
      process.stdout.write(`target=${TARGET}\n`);
      process.stdout.write(`method=${METHOD}\n`);
      process.stdout.write(`workers=${WORKERS} concurrency_per_worker=${CONCURRENCY_PER_WORKER}\n`);
      process.stdout.write(`duration_sec=${elapsed}\n`);
      process.stdout.write(`sent=${totals.sent} ok=${totals.ok} failed=${totals.failed} timeout=${totals.timeout} ok_rate=${okRate}%\n`);
      process.stdout.write(
        `status: 2xx=${totals.status2xx} 3xx=${totals.status3xx} 4xx=${totals.status4xx} 5xx=${totals.status5xx}\n`
      );
      process.stdout.write(`avg_rps=${Math.floor(totals.sent / elapsed)}\n`);
      process.exit(0);
    }, 500);
  }, Math.max(1000, endAt - Date.now()));

  return;
}

const url = new URL(TARGET);
const isHttps = url.protocol === 'https:';
const lib = isHttps ? https : http;
const agent = new (isHttps ? https.Agent : http.Agent)({
  keepAlive: KEEP_ALIVE,
  keepAliveMsecs: 1000,
  maxSockets: MAX_SOCKETS_PER_WORKER,
  maxFreeSockets: Math.min(MAX_SOCKETS_PER_WORKER, 1024)
});

let stopping = false;
const local = {
  sent: 0,
  ok: 0,
  failed: 0,
  timeout: 0,
  status2xx: 0,
  status3xx: 0,
  status4xx: 0,
  status5xx: 0
};

function classifyStatus(code) {
  if (code >= 200 && code < 300) local.status2xx += 1;
  else if (code >= 300 && code < 400) local.status3xx += 1;
  else if (code >= 400 && code < 500) local.status4xx += 1;
  else if (code >= 500) local.status5xx += 1;
}

function flushStats() {
  if (process.send) {
    process.send({ type: 'stats', ...local });
  }
  local.sent = 0;
  local.ok = 0;
  local.failed = 0;
  local.timeout = 0;
  local.status2xx = 0;
  local.status3xx = 0;
  local.status4xx = 0;
  local.status5xx = 0;
}

function oneLoop() {
  if (stopping) return;

  local.sent += 1;
  let timedOut = false;
  const req = lib.request({
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    method: METHOD,
    path: `${url.pathname}${url.search}`,
    headers: HEADERS,
    agent
  }, (res) => {
    classifyStatus(res.statusCode || 0);
    if ((res.statusCode || 0) >= 200 && (res.statusCode || 0) < 400) {
      local.ok += 1;
    } else {
      local.failed += 1;
    }
    res.resume();
    res.on('end', oneLoop);
  });

  req.setTimeout(REQUEST_TIMEOUT_MS, () => {
    timedOut = true;
    local.timeout += 1;
    local.failed += 1;
    req.destroy(new Error('timeout'));
  });
  req.on('error', () => {
    if (!timedOut) {
      local.failed += 1;
    }
    setImmediate(oneLoop);
  });

  if (BODY) req.write(BODY);
  req.end();
}

for (let i = 0; i < CONCURRENCY_PER_WORKER; i += 1) {
  oneLoop();
}

const statsTimer = setInterval(flushStats, PRINT_INTERVAL_MS);
process.on('message', (msg) => {
  if (!msg || msg.type !== 'stop') return;
  stopping = true;
  clearInterval(statsTimer);
  flushStats();
  setTimeout(() => process.exit(0), 100);
});
