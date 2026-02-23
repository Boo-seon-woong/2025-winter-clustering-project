'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

function parseIntOrDefault(value, fallback) {
  const n = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadDotEnv() {
  const explicit = process.env.ENV_PATH;
  const candidates = explicit
    ? [explicit]
    : [
        path.resolve(__dirname, '.env'),
        path.resolve(__dirname, '..', 'rocksdb_ingress', '.env'),
        path.resolve(__dirname, '..', 'rdb_new', '.env'),
        path.resolve(process.cwd(), '.env')
      ];

  for (const envPath of candidates) {
    if (!envPath || !fs.existsSync(envPath)) {
      continue;
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
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith('\'') && value.endsWith('\''))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
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

  if (!endpoint.startsWith('http://') && !endpoint.startsWith('https://')) {
    endpoint = `http://${endpoint}`;
  }

  try {
    const u = new URL(endpoint);
    const port = parseIntOrDefault(u.port, u.protocol === 'https:' ? 443 : 80);
    if (!u.hostname || port <= 0) {
      return null;
    }
    return { id, host: u.hostname, port };
  } catch (_err) {
    return null;
  }
}

function parseNodes(raw) {
  const out = String(raw || '')
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

function parseJsonSafe(text) {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (_err) {
    return null;
  }
}

function joinPath(basePath, suffix) {
  const base = String(basePath || '/');
  const head = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${head}${suffix}`;
}

function requestJsonOnce(baseUrl, method, pathname, payload, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl);
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const body = payload ? JSON.stringify(payload) : '';

    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        method,
        path: joinPath(u.pathname, pathname),
        headers: {
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
          ...(headers || {})
        }
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            headers: res.headers || {},
            text: data,
            json: parseJsonSafe(data)
          });
        });
      }
    );

    req.setTimeout(timeoutMs, () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function isRetriableStatus(status) {
  return status === 429 || status >= 500;
}

async function requestJsonWithRetry(baseUrl, method, pathname, payload, headers, timeoutMs, retries) {
  let lastErr = null;
  let lastRes = null;

  const attempts = Math.max(1, retries + 1);
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await requestJsonOnce(baseUrl, method, pathname, payload, headers, timeoutMs);
      lastRes = res;
      if (i < attempts - 1 && isRetriableStatus(res.status)) {
        await sleep(100 * (i + 1));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await sleep(100 * (i + 1));
        continue;
      }
    }
  }

  if (lastRes) {
    return lastRes;
  }
  throw lastErr || new Error('request failed');
}

function runPool(items, concurrency, worker) {
  const queue = [...items];
  const count = Math.max(1, Math.min(concurrency, items.length));

  const runners = Array.from({ length: count }, async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) {
        return;
      }
      await worker(item);
    }
  });

  return Promise.all(runners);
}

function writeJsonFile(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function buildConfig() {
  const nodes = parseNodes(process.env.INGRESS_NODES || process.env.SERVER_CLUSTER_NODES || '');
  if (!nodes.length) {
    throw new Error('INGRESS_NODES is empty. Set it in rocksdb_ingress/.env or environment.');
  }

  const baseUrl =
    process.env.BASE_URL ||
    `http://${process.env.INGRESS_HOST || '127.0.0.1'}:${process.env.INGRESS_PORT || '8080'}`;

  const userCount = parseIntOrDefault(process.env.USER_COUNT || process.env.COUNT || '1000', 1000);
  const startIndex = parseIntOrDefault(process.env.START_INDEX || '1', 1);

  return {
    baseUrl,
    userCount: userCount > 0 ? userCount : 100,
    startIndex: startIndex > 0 ? startIndex : 1,
    concurrency: Math.max(1, parseIntOrDefault(process.env.CONCURRENCY || '1', 1)),
    emailPrefix: process.env.EMAIL_PREFIX || 'k6user',
    emailDomain: process.env.EMAIL_DOMAIN || 'example.com',
    namePrefix: process.env.NAME_PREFIX || 'K6 Load',
    password: process.env.PASSWORD || 'Passw0rd!',
    affinityCookieName: process.env.AFFINITY_COOKIE_NAME || process.env.INGRESS_AFFINITY_COOKIE || 'RDB_INGRESS_AFFINITY',
    requestTimeoutMs: Math.max(300, parseIntOrDefault(process.env.REQUEST_TIMEOUT_MS || '4000', 4000)),
    requestRetries: Math.max(0, parseIntOrDefault(process.env.REQUEST_RETRIES || '2', 2)),
    tracePath: path.resolve(process.cwd(), process.env.TRACE_PATH || './create_accounts_trace.json'),
    nodes
  };
}

function buildAccount(cfg, index) {
  return {
    index,
    email: `${cfg.emailPrefix}${index}@${cfg.emailDomain}`,
    name: `${cfg.namePrefix} ${index}`,
    password: cfg.password
  };
}

function cookieHeader(cookieName, cookieValue) {
  return `${cookieName}=${encodeURIComponent(cookieValue)}`;
}

function isExistsRegisterResponse(registerRes) {
  if (registerRes.status !== 409) {
    return false;
  }
  const msg =
    (registerRes.json && typeof registerRes.json.error === 'string' && registerRes.json.error) ||
    registerRes.text ||
    '';
  return msg.toLowerCase().includes('exists');
}

async function loginAndMe(cfg, account, nodeId) {
  const cookie = cookieHeader(cfg.affinityCookieName, nodeId);

  const loginRes = await requestJsonWithRetry(
    cfg.baseUrl,
    'POST',
    '/api/login',
    { email: account.email, password: account.password },
    { Cookie: cookie },
    cfg.requestTimeoutMs,
    cfg.requestRetries
  );

  const token =
    loginRes.status === 200 &&
    loginRes.json &&
    loginRes.json.ok === true &&
    typeof loginRes.json.token === 'string' &&
    loginRes.json.token
      ? loginRes.json.token
      : '';

  if (!token) {
    return {
      ok: false,
      token: '',
      nodeId,
      login: loginRes,
      me: { status: 0, body: '' }
    };
  }

  const meRes = await requestJsonWithRetry(
    cfg.baseUrl,
    'GET',
    '/api/me',
    null,
    { Cookie: cookie, Authorization: `Bearer ${token}` },
    cfg.requestTimeoutMs,
    cfg.requestRetries
  );

  const meOk = meRes.status === 200 && meRes.json && meRes.json.ok === true;
  return {
    ok: meOk,
    token,
    nodeId,
    login: loginRes,
    me: meRes
  };
}

async function createOneAccount(cfg, account, preferredNode) {
  const cookie = cookieHeader(cfg.affinityCookieName, preferredNode.id);

  const registerRes = await requestJsonWithRetry(
    cfg.baseUrl,
    'POST',
    '/api/register',
    {
      email: account.email,
      name: account.name,
      password: account.password
    },
    { Cookie: cookie },
    cfg.requestTimeoutMs,
    cfg.requestRetries
  );

  const registerCreated = registerRes.status === 200;
  const registerExists = isExistsRegisterResponse(registerRes);
  const registerStatus = registerCreated ? 'created' : registerExists ? 'exists' : 'failed';

  let auth = await loginAndMe(cfg, account, preferredNode.id);

  if (!auth.ok && registerExists) {
    for (const node of cfg.nodes) {
      if (node.id === preferredNode.id) {
        continue;
      }
      const candidate = await loginAndMe(cfg, account, node.id);
      if (candidate.ok) {
        auth = candidate;
        break;
      }
    }
  }

  const success = registerStatus !== 'failed' && auth.ok;
  const error =
    success
      ? ''
      : registerStatus === 'failed'
        ? (registerRes.json && registerRes.json.error) || registerRes.text || `register status=${registerRes.status}`
        : (auth.login.json && auth.login.json.error) || auth.login.text || `login status=${auth.login.status}`;

  return {
    account,
    target_node: preferredNode.id,
    effective_node: auth.nodeId || '',
    register_status: registerStatus,
    login_ok: auth.ok,
    success,
    error,
    register: {
      status: registerRes.status,
      body: registerRes.json || registerRes.text
    },
    login: {
      status: auth.login.status,
      body: auth.login.json || auth.login.text
    },
    me: {
      status: auth.me.status,
      body: auth.me.json || auth.me.text
    }
  };
}

async function main() {
  loadDotEnv();
  const cfg = buildConfig();
  const now = new Date().toISOString();

  const tasks = [];
  for (let i = 0; i < cfg.userCount; i += 1) {
    const accountIndex = cfg.startIndex + i;
    const node = cfg.nodes[i % cfg.nodes.length];
    tasks.push({
      account: buildAccount(cfg, accountIndex),
      node
    });
  }

  console.log(
    `[start] base=${cfg.baseUrl} users=${cfg.userCount} nodes=${cfg.nodes.length} concurrency=${cfg.concurrency}`
  );
  console.log(`[start] cookie=${cfg.affinityCookieName} retries=${cfg.requestRetries} timeout_ms=${cfg.requestTimeoutMs}`);

  const results = [];
  await runPool(tasks, cfg.concurrency, async (task) => {
    let result;
    try {
      result = await createOneAccount(cfg, task.account, task.node);
    } catch (err) {
      result = {
        account: task.account,
        target_node: task.node.id,
        effective_node: '',
        register_status: 'failed',
        login_ok: false,
        success: false,
        error: err.message || 'request failed',
        register: { status: 0, body: '' },
        login: { status: 0, body: '' },
        me: { status: 0, body: '' }
      };
    }

    results.push(result);
    console.log(
      `[${result.target_node}] ${result.account.email} -> ${result.register_status}/${result.login_ok ? 'login_ok' : 'login_fail'}`
    );
  });

  results.sort((a, b) => a.account.index - b.account.index);

  const summary = {
    total: results.length,
    created: results.filter((x) => x.register_status === 'created').length,
    exists: results.filter((x) => x.register_status === 'exists').length,
    register_failed: results.filter((x) => x.register_status === 'failed').length,
    login_ok: results.filter((x) => x.login_ok).length,
    login_failed: results.filter((x) => !x.login_ok).length,
    success: results.filter((x) => x.success).length,
    failed: results.filter((x) => !x.success).length
  };

  const trace = {
    generated_at: now,
    config: {
      base_url: cfg.baseUrl,
      user_count: cfg.userCount,
      start_index: cfg.startIndex,
      concurrency: cfg.concurrency,
      request_timeout_ms: cfg.requestTimeoutMs,
      request_retries: cfg.requestRetries,
      affinity_cookie_name: cfg.affinityCookieName,
      nodes: cfg.nodes
    },
    summary,
    details: results
  };

  writeJsonFile(cfg.tracePath, trace);

  console.log(`[done] summary=${JSON.stringify(summary)}`);
  console.log(`[done] trace=${cfg.tracePath}`);

  if (summary.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`[fatal] ${err.message || err}`);
  process.exit(1);
});
