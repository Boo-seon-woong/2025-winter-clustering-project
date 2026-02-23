'use strict';

const http = require('http');

const KVS_HOST = process.env.KVS_HOST || '127.0.0.1';
const KVS_PORT = Number(process.env.KVS_PORT || 4000);
const TIMEOUT_MS = Number(process.env.KVS_TIMEOUT_MS || 1000);
const HARD_TIMEOUT_MS = Number(process.env.KVS_HARD_TIMEOUT_MS || Math.max(TIMEOUT_MS + 500, 2000));
const KVS_SLOW_MS = Number(process.env.KVS_SLOW_MS || 200);
const KVS_LOG_ALL = parseBoolEnv(process.env.KVS_LOG_ALL, false);

const KVS_KEEP_ALIVE = parseBoolEnv(process.env.KVS_KEEP_ALIVE, true);
const KVS_KEEP_ALIVE_MSECS = clampPositiveInt(Number.parseInt(process.env.KVS_KEEP_ALIVE_MSECS || '1000', 10), 1000);
const KVS_MAX_SOCKETS = clampPositiveInt(Number.parseInt(process.env.KVS_MAX_SOCKETS || '1024', 10), 1024);
const KVS_MAX_FREE_SOCKETS = clampPositiveInt(Number.parseInt(process.env.KVS_MAX_FREE_SOCKETS || '256', 10), 256);

const KVS_RETRY_ATTEMPTS = clampPositiveInt(Number.parseInt(process.env.KVS_RETRY_ATTEMPTS || '2', 10), 2);
const KVS_RETRY_BASE_MS = clampPositiveInt(Number.parseInt(process.env.KVS_RETRY_BASE_MS || '20', 10), 20);
const KVS_RETRY_MAX_MS = clampPositiveInt(Number.parseInt(process.env.KVS_RETRY_MAX_MS || '120', 10), 120);

const KVS_CB_FAILURE_THRESHOLD = clampPositiveInt(Number.parseInt(process.env.KVS_CB_FAILURE_THRESHOLD || '8', 10), 8);
const KVS_CB_COOLDOWN_MS = clampPositiveInt(Number.parseInt(process.env.KVS_CB_COOLDOWN_MS || '500', 10), 500);

const agent = new http.Agent({
  keepAlive: KVS_KEEP_ALIVE,
  keepAliveMsecs: KVS_KEEP_ALIVE_MSECS,
  maxSockets: KVS_MAX_SOCKETS,
  maxFreeSockets: KVS_MAX_FREE_SOCKETS
});

let kvsReqSeq = 0;
const circuit = {
  consecutiveFailures: 0,
  openUntil: 0
};

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

function logKvs(prefix, fields) {
  const parts = Object.entries(fields || {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  console.log(`[kvs:${prefix}] ${parts.join(' ')}`);
}

function formEncode(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj || {})) {
    if (v !== undefined && v !== null) {
      p.set(k, String(v));
    }
  }
  return p.toString();
}

function formDecode(body) {
  const p = new URLSearchParams(body || '');
  const out = {};
  for (const [k, v] of p.entries()) {
    out[k] = v;
  }
  return out;
}

function markSuccess() {
  circuit.consecutiveFailures = 0;
  circuit.openUntil = 0;
}

function markFailure(err) {
  if (err && Number.isFinite(err.status) && err.status >= 400 && err.status < 500) {
    return;
  }
  circuit.consecutiveFailures += 1;
  if (circuit.consecutiveFailures >= KVS_CB_FAILURE_THRESHOLD) {
    circuit.openUntil = Date.now() + KVS_CB_COOLDOWN_MS;
    circuit.consecutiveFailures = 0;
  }
}

function shouldRetry(err, attempt, maxAttempts) {
  if (attempt >= maxAttempts) {
    return false;
  }
  if (err && Number.isFinite(err.status) && err.status >= 400 && err.status < 500) {
    return false;
  }
  return true;
}

function backoffMs(attempt) {
  const base = Math.min(KVS_RETRY_BASE_MS * (2 ** Math.max(0, attempt - 1)), KVS_RETRY_MAX_MS);
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(base / 3)));
  return base + jitter;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function postFormOnce(path, payload) {
  const reqId = ++kvsReqSeq;
  const startedAt = Date.now();
  const socketTimeoutMs = clampPositiveInt(TIMEOUT_MS, 1000);
  const hardTimeoutMs = clampPositiveInt(HARD_TIMEOUT_MS, socketTimeoutMs + 500);

  return new Promise((resolve, reject) => {
    const body = formEncode(payload);
    let settled = false;
    let hardTimer = null;

    function finishOk(form, statusCode) {
      if (settled) {
        return;
      }
      settled = true;
      if (hardTimer) {
        clearTimeout(hardTimer);
      }
      const elapsedMs = Date.now() - startedAt;
      if (KVS_LOG_ALL || elapsedMs >= clampPositiveInt(KVS_SLOW_MS, 200)) {
        logKvs('ok', {
          id: reqId,
          path,
          status: statusCode || 200,
          ms: elapsedMs,
          timeout_ms: socketTimeoutMs,
          hard_timeout_ms: hardTimeoutMs
        });
      }
      resolve(form);
    }

    function finishErr(err, statusCode, form) {
      if (settled) {
        return;
      }
      settled = true;
      if (hardTimer) {
        clearTimeout(hardTimer);
      }
      const elapsedMs = Date.now() - startedAt;
      if (statusCode) {
        err.status = statusCode;
      }
      if (form) {
        err.form = form;
      }
      logKvs('error', {
        id: reqId,
        path,
        status: statusCode || 0,
        ms: elapsedMs,
        timeout_ms: socketTimeoutMs,
        hard_timeout_ms: hardTimeoutMs,
        error: err.message || 'kvs error'
      });
      reject(err);
    }

    const req = http.request({
      host: KVS_HOST,
      port: KVS_PORT,
      path,
      method: 'POST',
      agent,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        const form = formDecode(data);
        if ((res.statusCode || 500) >= 400 || form.ok !== '1') {
          const err = new Error(form.error || 'kvs error');
          finishErr(err, res.statusCode || 500, form);
          return;
        }
        finishOk(form, res.statusCode || 200);
      });
    });

    hardTimer = setTimeout(() => {
      const err = new Error('kvs hard timeout');
      err.code = 'timeout';
      req.destroy(err);
    }, hardTimeoutMs);

    req.setTimeout(socketTimeoutMs, () => req.destroy(new Error('kvs socket timeout')));
    req.on('error', (err) => finishErr(err, 0, null));
    req.write(body);
    req.end();
  });
}

async function postForm(path, payload, options) {
  const opts = options || {};
  const idempotent = !!opts.idempotent;
  const maxAttempts = idempotent ? Math.max(1, KVS_RETRY_ATTEMPTS) : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (Date.now() < circuit.openUntil) {
      const err = new Error('kvs circuit open');
      err.code = 'circuit_open';
      throw err;
    }

    try {
      const out = await postFormOnce(path, payload);
      markSuccess();
      return out;
    } catch (err) {
      markFailure(err);
      if (!shouldRetry(err, attempt, maxAttempts)) {
        throw err;
      }
      await sleep(backoffMs(attempt));
    }
  }

  const err = new Error('kvs unavailable');
  err.code = 'kvs_unavailable';
  throw err;
}

async function createAccount(id, name, password_hash) {
  return postForm('/account/create', { id, name, password_hash }, { idempotent: false });
}

async function getAccount(id) {
  const r = await postForm('/account/get', { id }, { idempotent: true });
  return {
    id: r.id,
    name: r.name,
    password_hash: r.password_hash,
    created_at: Number(r.created_at || 0)
  };
}

async function createPost(account_id, title, content) {
  const r = await postForm('/post/create', { account_id, title, content }, { idempotent: false });
  return {
    id: r.id,
    account_id: r.account_id || account_id,
    title: r.title || title,
    content: r.content || content,
    created_at: Number(r.created_at || Date.now())
  };
}

async function getPost(id) {
  const r = await postForm('/post/get', { id }, { idempotent: true });
  return {
    id: r.id,
    account_id: r.account_id,
    title: r.title,
    content: r.content,
    created_at: Number(r.created_at || 0)
  };
}

async function listTitles(limit) {
  const r = await postForm('/post/titles', { limit }, { idempotent: true });
  const count = Number(r.count || 0);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      id: r[`id${i}`],
      account_id: r[`account_id${i}`],
      title: r[`title${i}`],
      created_at: Number(r[`created_at${i}`] || 0)
    });
  }
  return out;
}

module.exports = {
  createAccount,
  getAccount,
  createPost,
  getPost,
  listTitles
};
