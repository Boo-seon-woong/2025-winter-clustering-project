'use strict';

const cluster = require('cluster');
const os = require('os');
const http = require('http');
const https = require('https');
const { loadDotEnv } = require('./load_env');

loadDotEnv();

const LAT_BUCKET_MAX_MS = 20000;

function envInt(name, fallback) {
  const v = Number.parseInt(process.env[name] || String(fallback), 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function envOptionalInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return fallback;
  }
  const v = Number.parseInt(String(raw), 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function envNonNegativeInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return fallback;
  }
  const v = Number.parseInt(String(raw), 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

function envFloat(name, fallback) {
  const v = Number.parseFloat(process.env[name] || String(fallback));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const s = String(raw).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return fallback;
}

function createLatencyStats() {
  return {
    count: 0,
    sum: 0,
    min: Number.POSITIVE_INFINITY,
    max: 0,
    buckets: new Array(LAT_BUCKET_MAX_MS + 2).fill(0)
  };
}

function addLatency(stats, ms) {
  const v = Number.isFinite(ms) && ms >= 0 ? ms : 0;
  const i = Math.floor(Math.min(v, LAT_BUCKET_MAX_MS + 1));
  stats.count += 1;
  stats.sum += v;
  if (v < stats.min) stats.min = v;
  if (v > stats.max) stats.max = v;
  stats.buckets[i] += 1;
}

function mergeLatency(dst, src) {
  if (!src) return;
  dst.count += src.count || 0;
  dst.sum += src.sum || 0;
  dst.min = Math.min(dst.min, Number.isFinite(src.min) ? src.min : Number.POSITIVE_INFINITY);
  dst.max = Math.max(dst.max, src.max || 0);
  if (Array.isArray(src.buckets)) {
    for (let i = 0; i < dst.buckets.length; i += 1) {
      dst.buckets[i] += src.buckets[i] || 0;
    }
  }
}

function percentile(stats, q) {
  if (!stats.count) return 0;
  const rank = Math.ceil(stats.count * q);
  let acc = 0;
  for (let i = 0; i < stats.buckets.length; i += 1) {
    acc += stats.buckets[i];
    if (acc >= rank) return i;
  }
  return LAT_BUCKET_MAX_MS + 1;
}

function latencySummary(stats) {
  if (!stats.count) {
    return { count: 0, min: 0, max: 0, avg: 0, mean: 0, p95: 0, p99: 0, p999: 0 };
  }
  const avg = stats.sum / stats.count;
  return {
    count: stats.count,
    min: stats.min,
    max: stats.max,
    avg,
    mean: avg,
    p95: percentile(stats, 0.95),
    p99: percentile(stats, 0.99),
    p999: percentile(stats, 0.999)
  };
}

function createReqStats() {
  return {
    total: 0,
    ok: 0,
    fail: 0,
    timeout: 0,
    status2xx: 0,
    status3xx: 0,
    status4xx: 0,
    status5xx: 0,
    latency: createLatencyStats()
  };
}

function addReqResult(stats, res, isOk) {
  stats.total += 1;
  addLatency(stats.latency, res.ms);
  if (res.timeout) stats.timeout += 1;
  if (res.status >= 200 && res.status < 300) stats.status2xx += 1;
  else if (res.status >= 300 && res.status < 400) stats.status3xx += 1;
  else if (res.status >= 400 && res.status < 500) stats.status4xx += 1;
  else if (res.status >= 500) stats.status5xx += 1;
  if (isOk) stats.ok += 1;
  else stats.fail += 1;
}

function mergeReqStats(dst, src) {
  if (!src) return;
  dst.total += src.total || 0;
  dst.ok += src.ok || 0;
  dst.fail += src.fail || 0;
  dst.timeout += src.timeout || 0;
  dst.status2xx += src.status2xx || 0;
  dst.status3xx += src.status3xx || 0;
  dst.status4xx += src.status4xx || 0;
  dst.status5xx += src.status5xx || 0;
  mergeLatency(dst.latency, src.latency);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function runPool(items, concurrency, handler) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= items.length) return;
      out[idx] = await handler(items[idx], idx);
    }
  }
  const jobs = [];
  const n = Math.min(concurrency, Math.max(1, items.length));
  for (let i = 0; i < n; i += 1) jobs.push(worker());
  await Promise.all(jobs);
  return out;
}

const CFG = {
  baseUrl: process.env.BASE_URL || 'http://127.0.0.1:8080',
  workers: envInt('WORKERS', Math.max(1, (os.availableParallelism ? os.availableParallelism() : os.cpus().length) - 1)),
  timeoutMs: envInt('REQUEST_TIMEOUT_MS', 3000),
  durationSec: envInt('DURATION_SEC', 45),
  targetHz: envFloat('TARGET_HZ', 1),
  progressIntervalSec: envNonNegativeInt('PROGRESS_INTERVAL_SEC', 5),
  users: envOptionalInt('USERS', 0),
  startUsers: envInt('START_USERS', 50),
  maxUsers: envInt('MAX_USERS', 2000),
  stageStep: envInt('STAGE_STEP', 100),
  stopOnFail: envBool('STOP_ON_FAIL', true),
  loginConcurrency: envInt('LOGIN_CONCURRENCY', 64),
  userStartSpreadMs: envInt('USER_START_SPREAD_MS', 0),
  minCycleOkRate: envFloat('MIN_CYCLE_OK_RATE', 0.98),
  minLoginOkRate: envFloat('MIN_LOGIN_OK_RATE', 0.98),
  postP95Ms: envInt('POST_P95_MS', 1500),
  getP95Ms: envInt('GET_P95_MS', 1500),
  userStartIndex: envInt('USER_START_INDEX', 1),
  emailPrefix: process.env.EMAIL_PREFIX || 'k6user',
  emailDomain: process.env.EMAIL_DOMAIN || 'example.com',
  password: process.env.PASSWORD || 'Passw0rd!',
  getPath: process.env.GET_PATH || '/api/posts',
  postPath: process.env.POST_PATH || '/api/posts'
};

if (cluster.isPrimary) {
  void runController();
} else {
  void runWorker();
}

async function runController() {
  const singleRun = CFG.users > 0;
  if (singleRun) {
    console.log(
      `[config] base_url=${CFG.baseUrl} workers=${CFG.workers} duration_sec=${CFG.durationSec} ` +
      `users=${CFG.users} (single-run mode)`
    );
  } else {
    console.log(
      `[config] base_url=${CFG.baseUrl} workers=${CFG.workers} duration_sec=${CFG.durationSec} ` +
      `start_users=${CFG.startUsers} max_users=${CFG.maxUsers} step=${CFG.stageStep} stop_on_fail=${CFG.stopOnFail}`
    );
  }
  console.log(
    `[criteria] cycle_ok>=${CFG.minCycleOkRate} login_ok>=${CFG.minLoginOkRate} ` +
    `post_p95<=${CFG.postP95Ms}ms get_p95<=${CFG.getP95Ms}ms`
  );

  let lastPass = null;
  let firstFail = null;
  const start = singleRun ? CFG.users : CFG.startUsers;
  const max = singleRun ? CFG.users : CFG.maxUsers;
  const step = singleRun ? 1 : CFG.stageStep;
  for (let users = start; users <= max; users += step) {
    const result = await runStage(users);
    printStageResult(result);
    if (result.pass) {
      lastPass = result.users;
    } else if (firstFail === null) {
      firstFail = result.users;
      if (CFG.stopOnFail || singleRun) break;
    }
  }
/*
  console.log('\n=== result ===');
  if (lastPass !== null) {
    console.log(`last_pass_users=${lastPass}`);
  } else {
    console.log('last_pass_users=none');
  }
  if (firstFail !== null) {
    console.log(`first_fail_users=${firstFail}`);
  } else {
    console.log('first_fail_users=none');
  }*/
}

function pct(numerator, denominator) {
  if (!denominator) return 0;
  return (numerator / denominator) * 100;
}

function printReqSummary(name, stats) {
  const lat = latencySummary(stats.latency);
  const row = [
    name.padEnd(12),
    String(stats.total).padStart(8),
    String(stats.ok).padStart(8),
    String(stats.fail).padStart(8),
    String(stats.timeout).padStart(8),
    `${pct(stats.ok, stats.total).toFixed(2)}%`.padStart(9),
    lat.avg.toFixed(2).padStart(9),
    lat.mean.toFixed(2).padStart(9),
    lat.min.toFixed(2).padStart(9),
    lat.max.toFixed(2).padStart(9),
    lat.p95.toFixed(2).padStart(9),
    lat.p99.toFixed(2).padStart(9),
    lat.p999.toFixed(2).padStart(9),
    String(stats.status2xx).padStart(8),
    String(stats.status3xx).padStart(8),
    String(stats.status4xx).padStart(8),
    String(stats.status5xx).padStart(8)
  ].join(' ');
  console.log(row);
}

function printStageResult(r) {
  const loginFail = Math.max(0, r.loginTotal - r.loginOk);
  const cycleFail = Math.max(0, r.cycleTotal - r.cycleOk);
  console.log(`\n--- stage users=${r.users} pass=${r.pass ? 'yes' : 'no'} ---`);
  console.log(`login_ok=${r.loginOk}/${r.loginTotal} (${r.loginOkRate.toFixed(2)}%) login_fail=${loginFail}`);
  console.log(`cycle_ok=${r.cycleOk}/${r.cycleTotal} (${r.cycleOkRate.toFixed(2)}%) cycle_fail=${cycleFail}`);
  console.log('');
  console.log(
    [
      'metric'.padEnd(12),
      'total'.padStart(8),
      'ok'.padStart(8),
      'fail'.padStart(8),
      'timeout'.padStart(8),
      'ok_rate'.padStart(9),
      'avg'.padStart(9),
      'mean'.padStart(9),
      'min'.padStart(9),
      'max'.padStart(9),
      'p95'.padStart(9),
      'p99'.padStart(9),
      'p99.9'.padStart(9),
      '2xx'.padStart(8),
      '3xx'.padStart(8),
      '4xx'.padStart(8),
      '5xx'.padStart(8)
    ].join(' ')
  );
  console.log('-'.repeat(182));
  printReqSummary('login', r.loginReq);
  printReqSummary('create_post', r.postReq);
  printReqSummary('list_posts', r.getReq);
}

async function runStage(totalUsers) {
  const workers = [];
  const baseStart = CFG.userStartIndex;
  let assigned = 0;
  const perWorker = Math.floor(totalUsers / CFG.workers);
  const rem = totalUsers % CFG.workers;

  for (let i = 0; i < CFG.workers; i += 1) {
    const count = perWorker + (i < rem ? 1 : 0);
    if (count <= 0) continue;
    const ws = baseStart + assigned;
    assigned += count;
    workers.push(cluster.fork({
      STAGE_USERS: String(count),
      STAGE_USER_START: String(ws),
      STAGE_DURATION_SEC: String(CFG.durationSec),
      TARGET_HZ: String(CFG.targetHz),
      PROGRESS_INTERVAL_SEC: String(CFG.progressIntervalSec),
      REQUEST_TIMEOUT_MS: String(CFG.timeoutMs),
      BASE_URL: CFG.baseUrl,
      PASSWORD: CFG.password,
      EMAIL_PREFIX: CFG.emailPrefix,
      EMAIL_DOMAIN: CFG.emailDomain,
      LOGIN_CONCURRENCY: String(CFG.loginConcurrency),
      USER_START_SPREAD_MS: String(CFG.userStartSpreadMs),
      GET_PATH: CFG.getPath,
      POST_PATH: CFG.postPath
    }));
  }

  const merged = {
    users: totalUsers,
    loginTotal: 0,
    loginOk: 0,
    cycleTotal: 0,
    cycleOk: 0,
    loginReq: createReqStats(),
    postReq: createReqStats(),
    getReq: createReqStats()
  };
  const progressByWorker = new Map();
  const stageStartedAt = Date.now();
  let progressTimer = null;

  function mergedFromProgress() {
    const out = {
      loginTotal: 0,
      loginOk: 0,
      cycleTotal: 0,
      cycleOk: 0,
      loginReq: createReqStats(),
      postReq: createReqStats(),
      getReq: createReqStats()
    };
    for (const p of progressByWorker.values()) {
      out.loginTotal += p.loginTotal || 0;
      out.loginOk += p.loginOk || 0;
      out.cycleTotal += p.cycleTotal || 0;
      out.cycleOk += p.cycleOk || 0;
      mergeReqStats(out.loginReq, p.loginReq);
      mergeReqStats(out.postReq, p.postReq);
      mergeReqStats(out.getReq, p.getReq);
    }
    return out;
  }

  function printStageProgress() {
    const cur = mergedFromProgress();
    const elapsed = Math.max(1, Math.floor((Date.now() - stageStartedAt) / 1000));
    const loginRate = pct(cur.loginOk, cur.loginTotal);
    const cycleRate = pct(cur.cycleOk, cur.cycleTotal);
    const post = latencySummary(cur.postReq.latency);
    const get = latencySummary(cur.getReq.latency);
    console.log(
      `[progress users=${totalUsers} t=${elapsed}s] ` +
      `login_ok=${cur.loginOk}/${cur.loginTotal} (${loginRate.toFixed(2)}%) ` +
      `cycle_ok=${cur.cycleOk}/${cur.cycleTotal} (${cycleRate.toFixed(2)}%) ` +
      `post_p95=${post.p95.toFixed(2)}ms get_p95=${get.p95.toFixed(2)}ms`
    );
  }

  if (CFG.progressIntervalSec > 0) {
    progressTimer = setInterval(printStageProgress, CFG.progressIntervalSec * 1000);
  }

  await Promise.all(workers.map((w) => new Promise((resolve) => {
    let got = false;
    w.on('message', (msg) => {
      if (!msg || msg.type !== 'stage_result') return;
      got = true;
      progressByWorker.set(w.id, msg);
    });
    w.on('message', (msg) => {
      if (!msg || msg.type !== 'stage_progress') return;
      progressByWorker.set(w.id, msg);
    });
    w.on('exit', () => {
      if (!got) {
        merged.loginTotal += 1;
      }
      resolve();
    });
  })));

  if (progressTimer) {
    clearInterval(progressTimer);
  }
  const finalProgress = mergedFromProgress();
  merged.loginTotal += finalProgress.loginTotal;
  merged.loginOk += finalProgress.loginOk;
  merged.cycleTotal += finalProgress.cycleTotal;
  merged.cycleOk += finalProgress.cycleOk;
  mergeReqStats(merged.loginReq, finalProgress.loginReq);
  mergeReqStats(merged.postReq, finalProgress.postReq);
  mergeReqStats(merged.getReq, finalProgress.getReq);

  const loginOkRate = pct(merged.loginOk, merged.loginTotal);
  const cycleOkRate = pct(merged.cycleOk, merged.cycleTotal);
  const postP95 = latencySummary(merged.postReq.latency).p95;
  const getP95 = latencySummary(merged.getReq.latency).p95;
  const pass =
    (loginOkRate / 100) >= CFG.minLoginOkRate &&
    (cycleOkRate / 100) >= CFG.minCycleOkRate &&
    postP95 <= CFG.postP95Ms &&
    getP95 <= CFG.getP95Ms;

  return {
    users: totalUsers,
    pass,
    loginTotal: merged.loginTotal,
    loginOk: merged.loginOk,
    loginOkRate,
    cycleTotal: merged.cycleTotal,
    cycleOk: merged.cycleOk,
    cycleOkRate,
    loginReq: merged.loginReq,
    postReq: merged.postReq,
    getReq: merged.getReq
  };
}

async function runWorker() {
  const stageUsers = envInt('STAGE_USERS', 1);
  const userStart = envInt('STAGE_USER_START', 1);
  const durationSec = envInt('STAGE_DURATION_SEC', 30);
  const targetHz = envFloat('TARGET_HZ', 1);
  const progressIntervalSec = envNonNegativeInt('PROGRESS_INTERVAL_SEC', 5);
  const timeoutMs = envInt('REQUEST_TIMEOUT_MS', 3000);
  const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:8080';
  const emailPrefix = process.env.EMAIL_PREFIX || 'k6user';
  const emailDomain = process.env.EMAIL_DOMAIN || 'example.com';
  const password = process.env.PASSWORD || 'Passw0rd!';
  const loginConcurrency = envInt('LOGIN_CONCURRENCY', 64);
  const userStartSpreadMs = envInt('USER_START_SPREAD_MS', 0);
  const getPath = process.env.GET_PATH || '/api/posts';
  const postPath = process.env.POST_PATH || '/api/posts';

  const target = new URL(baseUrl);
  const isHttps = target.protocol === 'https:';
  const lib = isHttps ? https : http;
  const agent = new (isHttps ? https.Agent : http.Agent)({
    keepAlive: true,
    keepAliveMsecs: 1000,
    maxSockets: Math.max(1024, stageUsers * 4),
    maxFreeSockets: 1024
  });

  function reqJson(method, path, token, bodyObj) {
    const startedAt = Date.now();
    return new Promise((resolve) => {
      const body = bodyObj ? JSON.stringify(bodyObj) : '';
      const headers = {};
      let timedOut = false;
      if (body) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(body);
      }
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const req = lib.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        method,
        path,
        headers,
        agent
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch (_e) {}
          resolve({
            status: res.statusCode || 0,
            json,
            timeout: false,
            ms: Date.now() - startedAt
          });
        });
      });

      req.setTimeout(timeoutMs, () => {
        timedOut = true;
        req.destroy(new Error('timeout'));
      });
      req.on('error', () => {
        resolve({
          status: 0,
          json: null,
          timeout: timedOut,
          ms: Date.now() - startedAt
        });
      });
      if (body) req.write(body);
      req.end();
    });
  }

  const accounts = [];
  for (let i = 0; i < stageUsers; i += 1) {
    const idx = userStart + i;
    accounts.push({ email: `${emailPrefix}${idx}@${emailDomain}`, password });
  }

  const loginReq = createReqStats();
  const postReq = createReqStats();
  const getReq = createReqStats();

  const loginResults = await runPool(accounts, loginConcurrency, async (acc) => {
    const res = await reqJson('POST', '/api/login', '', { email: acc.email, password: acc.password });
    const ok = res.status === 200 && res.json && res.json.ok === true && !!res.json.token;
    addReqResult(loginReq, res, ok);
    return { email: acc.email, token: ok ? res.json.token : '' };
  });
  const activeUsers = loginResults.filter((r) => !!r.token);

  let cycleTotal = 0;
  let cycleOk = 0;
  const endAt = Date.now() + durationSec * 1000;
  const cycleIntervalMs = Math.max(1, Math.floor(1000 / Math.max(0.0001, targetHz)));

  function emitProgress(type) {
    if (!process.send) return;
    process.send({
      type,
      loginTotal: accounts.length,
      loginOk: activeUsers.length,
      cycleTotal,
      cycleOk,
      loginReq,
      postReq,
      getReq
    });
  }

  let progressTimer = null;
  if (progressIntervalSec > 0) {
    progressTimer = setInterval(() => emitProgress('stage_progress'), progressIntervalSec * 1000);
  }

  const loops = activeUsers.map((u, idx) => (async () => {
    const spread = Math.max(0, userStartSpreadMs);
    const offset = spread > 0 ? (idx % spread) : 0;
    if (offset > 0) await sleep(offset);
    while (Date.now() < endAt) {
      const cycleStarted = Date.now();

      const post = await reqJson('POST', postPath, u.token, {
        title: `stress title ${u.email} ${cycleStarted}`,
        content: `stress content ${u.email} ${cycleStarted}`
      });
      const postOk = post.status === 200 && post.json && post.json.ok === true && post.json.post && post.json.post.id;
      addReqResult(postReq, post, !!postOk);

      const get = await reqJson('GET', getPath, u.token, null);
      const getOk = get.status === 200 && get.json && get.json.ok === true && Array.isArray(get.json.posts);
      addReqResult(getReq, get, !!getOk);

      cycleTotal += 1;
      if (postOk && getOk) cycleOk += 1;

      const elapsed = Date.now() - cycleStarted;
      if (elapsed < cycleIntervalMs) await sleep(cycleIntervalMs - elapsed);
    }
  })());

  await Promise.all(loops);

  if (process.send) {
    emitProgress('stage_result');
  }
  if (progressTimer) {
    clearInterval(progressTimer);
  }
  process.exit(0);
}
