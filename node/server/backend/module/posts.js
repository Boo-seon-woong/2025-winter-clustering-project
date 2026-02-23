'use strict';

const kvs = require('./kvs');

const LIST_POSTS_CONCURRENCY = Number.parseInt(process.env.LIST_POSTS_CONCURRENCY || '8', 10);
const LIST_POSTS_BUDGET_MS = Number.parseInt(process.env.LIST_POSTS_BUDGET_MS || '3000', 10);
const LIST_POSTS_ITEM_TIMEOUT_MS = Number.parseInt(process.env.LIST_POSTS_ITEM_TIMEOUT_MS || '1000', 10);
const LIST_POSTS_TITLES_TIMEOUT_MS = Number.parseInt(process.env.LIST_POSTS_TITLES_TIMEOUT_MS || '1000', 10);
const LIST_POSTS_SLOW_MS = Number.parseInt(process.env.LIST_POSTS_SLOW_MS || '300', 10);
const LIST_POSTS_LOG_ALL = parseBoolEnv(process.env.LIST_POSTS_LOG_ALL, false);
const LIST_POSTS_LIMIT = Number.parseInt(process.env.LIST_POSTS_LIMIT || '100', 10);
const LIST_POSTS_CACHE_TTL_MS = Number.parseInt(process.env.LIST_POSTS_CACHE_TTL_MS || '120', 10);
const LIST_POSTS_CACHE_STALE_MS = Number.parseInt(process.env.LIST_POSTS_CACHE_STALE_MS || '3000', 10);
const AUTHOR_NAME_CACHE_TTL_MS = Number.parseInt(process.env.AUTHOR_NAME_CACHE_TTL_MS || '300000', 10);
const AUTHOR_NAME_CACHE_MAX = Number.parseInt(process.env.AUTHOR_NAME_CACHE_MAX || '10000', 10);

const sharedAuthorNameCache = new Map();
const sharedAuthorNameInflight = new Map();
const sharedFeedCache = {
  items: [],
  fetchedAt: 0,
  expiresAt: 0,
  inflight: null
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

function withTimeout(promise, timeoutMs, label) {
  const ms = clampPositiveInt(timeoutMs, 1000);
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label || 'operation'} timeout`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function getCachedAuthorName(accountId) {
  const now = Date.now();
  const entry = sharedAuthorNameCache.get(accountId);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= now) {
    sharedAuthorNameCache.delete(accountId);
    return null;
  }
  return entry.name;
}

function putCachedAuthorName(accountId, name) {
  const ttlMs = clampPositiveInt(AUTHOR_NAME_CACHE_TTL_MS, 300000);
  const maxEntries = clampPositiveInt(AUTHOR_NAME_CACHE_MAX, 10000);
  sharedAuthorNameCache.set(accountId, {
    name,
    expiresAt: Date.now() + ttlMs
  });
  if (sharedAuthorNameCache.size > maxEntries) {
    const oldestKey = sharedAuthorNameCache.keys().next().value;
    if (oldestKey) {
      sharedAuthorNameCache.delete(oldestKey);
    }
  }
}

async function resolveAuthorName(accountId, cache, timeoutMs) {
  if (!accountId) {
    return '';
  }
  if (cache && cache.has(accountId)) {
    return cache.get(accountId);
  }

  const shared = getCachedAuthorName(accountId);
  if (shared !== null) {
    if (cache) {
      cache.set(accountId, shared);
    }
    return shared;
  }

  if (sharedAuthorNameInflight.has(accountId)) {
    const inflightName = await sharedAuthorNameInflight.get(accountId);
    if (cache) {
      cache.set(accountId, inflightName);
    }
    return inflightName;
  }

  const fetchPromise = (async () => {
    let name = '';
    try {
      const account = timeoutMs
        ? await withTimeout(kvs.getAccount(accountId), timeoutMs, 'getAccount')
        : await kvs.getAccount(accountId);
      name = account && account.name ? account.name : '';
    } catch (_err) {
      name = '';
    }
    putCachedAuthorName(accountId, name);
    return name;
  })();
  sharedAuthorNameInflight.set(accountId, fetchPromise);

  let name = '';
  try {
    name = await fetchPromise;
  } catch (_err) {
    name = '';
  } finally {
    sharedAuthorNameInflight.delete(accountId);
  }

  if (cache) {
    cache.set(accountId, name);
  }
  return name;
}

function invalidateListCache() {
  sharedFeedCache.expiresAt = 0;
}

async function buildFeedSnapshot() {
  const startedAt = Date.now();
  const itemTimeoutMs = clampPositiveInt(LIST_POSTS_ITEM_TIMEOUT_MS, 1000);
  const titlesTimeoutMs = clampPositiveInt(LIST_POSTS_TITLES_TIMEOUT_MS, itemTimeoutMs);
  const feedLimit = clampPositiveInt(LIST_POSTS_LIMIT, 100);
  let timeoutCount = 0;
  let errorCount = 0;
  let processedCount = 0;

  const titles = await withTimeout(kvs.listTitles(feedLimit), titlesTimeoutMs, 'listTitles');
  if (!Array.isArray(titles) || titles.length === 0) {
    return [];
  }

  const authorNameCache = new Map();
  const out = new Array(titles.length);
  const budgetMs = clampPositiveInt(LIST_POSTS_BUDGET_MS, 3000);
  const deadline = Date.now() + budgetMs;
  const workerCount = Math.min(
    clampPositiveInt(LIST_POSTS_CONCURRENCY, 8),
    titles.length
  );

  let cursor = 0;
  async function worker() {
    while (true) {
      if (Date.now() >= deadline) {
        return;
      }
      const idx = cursor;
      cursor += 1;
      if (idx >= titles.length) {
        return;
      }

      const item = titles[idx];
      if (!item || !item.id) {
        continue;
      }

      try {
        let accountId = item.account_id || '';
        let title = item.title || '';
        let createdAt = Number(item.created_at || 0);

        if (!accountId) {
          // Compatibility fallback for older kvsd responses.
          const post = await withTimeout(kvs.getPost(item.id), itemTimeoutMs, 'getPost');
          accountId = post.account_id || '';
          title = post.title || title;
          createdAt = Number(post.created_at || createdAt || 0);
        }

        processedCount += 1;
        out[idx] = {
          id: item.id,
          title,
          email: accountId,
          name: await resolveAuthorName(accountId, authorNameCache, itemTimeoutMs),
          created_at: createdAt
        };
      } catch (err) {
        if (err && String(err.message || '').includes('timeout')) {
          timeoutCount += 1;
        } else {
          errorCount += 1;
        }
      }
    }
  }

  const workers = [];
  for (let i = 0; i < workerCount; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);

  const result = out.filter(Boolean);
  const elapsedMs = Date.now() - startedAt;
  if (LIST_POSTS_LOG_ALL || elapsedMs >= clampPositiveInt(LIST_POSTS_SLOW_MS, 300) || timeoutCount > 0) {
    console.log(
      `[posts:list:refresh] titles=${titles.length} returned=${result.length} ` +
      `processed=${processedCount} timeout=${timeoutCount} error=${errorCount} ` +
      `concurrency=${workerCount} budget_ms=${budgetMs} item_timeout_ms=${itemTimeoutMs} ms=${elapsedMs}`
    );
  }
  return result;
}

async function getFeedSnapshot() {
  const now = Date.now();
  if (sharedFeedCache.expiresAt > now) {
    return sharedFeedCache.items;
  }
  if (sharedFeedCache.inflight) {
    return sharedFeedCache.inflight;
  }

  sharedFeedCache.inflight = (async () => {
    try {
      const fresh = await buildFeedSnapshot();
      const refreshedAt = Date.now();
      sharedFeedCache.items = fresh;
      sharedFeedCache.fetchedAt = refreshedAt;
      sharedFeedCache.expiresAt = refreshedAt + clampPositiveInt(LIST_POSTS_CACHE_TTL_MS, 120);
      return fresh;
    } catch (err) {
      const staleWindowMs = clampPositiveInt(LIST_POSTS_CACHE_STALE_MS, 3000);
      if (sharedFeedCache.items.length > 0 && (now - sharedFeedCache.fetchedAt) <= staleWindowMs) {
        return sharedFeedCache.items;
      }
      throw err;
    } finally {
      sharedFeedCache.inflight = null;
    }
  })();

  return sharedFeedCache.inflight;
}

async function createPost(email, title, content) {
  const created = await kvs.createPost(email, title, content);
  const createdId = created && created.id ? created.id : '';
  if (!createdId) {
    throw new Error('post create failed');
  }

  let post = {
    id: createdId,
    title: created.title || title,
    content: created.content || content,
    email: created.account_id || email,
    name: '',
    created_at: Number(created.created_at || Date.now())
  };

  if (!created.account_id || !created.title || !created.content || !created.created_at) {
    const loaded = await kvs.getPost(createdId);
    post = {
      id: loaded.id,
      title: loaded.title,
      content: loaded.content,
      email: loaded.account_id,
      name: '',
      created_at: loaded.created_at
    };
  }

  post.name = await resolveAuthorName(post.email);
  invalidateListCache();
  return post;
}

async function listPosts(scope, email) {
  const startedAt = Date.now();
  try {
    const feed = await getFeedSnapshot();
    if (scope === 'me') {
      const mine = feed.filter((item) => item.email === email);
      if (LIST_POSTS_LOG_ALL) {
        console.log(`[posts:list] scope=me email=${email} returned=${mine.length} ms=${Date.now() - startedAt}`);
      }
      return mine;
    }
    if (LIST_POSTS_LOG_ALL) {
      console.log(`[posts:list] scope=all email=${email} returned=${feed.length} ms=${Date.now() - startedAt}`);
    }
    return feed;
  } catch (_err) {
    console.log(`[posts:list] scope=${scope} email=${email} status=feed_failed ms=${Date.now() - startedAt}`);
    return [];
  }
}

async function getPost(id) {
  if (!id) {
    return null;
  }
  const post = await kvs.getPost(id);
  return {
    id: post.id,
    title: post.title,
    content: post.content,
    email: post.account_id,
    name: await resolveAuthorName(post.account_id),
    created_at: post.created_at
  };
}

module.exports = {
  createPost,
  listPosts,
  getPost,
  invalidateListCache
};
