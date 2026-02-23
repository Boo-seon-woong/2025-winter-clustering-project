'use strict';

const crypto = require('crypto');

const DEFAULT_SECRET = process.env.AUTH_TOKEN_SECRET || process.env.PASSWORD_SALT || 'rdb-demo-auth-secret';
const TOKEN_TTL_SEC = clampPositiveInt(Number.parseInt(process.env.AUTH_TOKEN_TTL_SEC || '86400', 10), 86400);
const CLOCK_SKEW_SEC = clampPositiveInt(Number.parseInt(process.env.AUTH_TOKEN_CLOCK_SKEW_SEC || '10', 10), 10);

function clampPositiveInt(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function toBase64Url(raw) {
  return Buffer.from(raw)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64Url(raw) {
  const normalized = String(raw || '').replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(normalized + '='.repeat(padLength), 'base64');
}

function sign(value) {
  return crypto
    .createHmac('sha256', DEFAULT_SECRET)
    .update(value)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function safeEqualString(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) {
    return false;
  }
  try {
    return crypto.timingSafeEqual(left, right);
  } catch (_err) {
    return false;
  }
}

function issueToken(user) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: String(user && user.email ? user.email : ''),
    name: String(user && user.name ? user.name : ''),
    iat: now,
    exp: now + TOKEN_TTL_SEC
  };
  const header = { typ: 'JWT', alg: 'HS256' };
  const encodedHeader = toBase64Url(JSON.stringify(header));
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = sign(signingInput);
  return `${signingInput}.${signature}`;
}

function verifyToken(token) {
  const raw = String(token || '').trim();
  if (!raw) {
    return null;
  }
  const parts = raw.split('.');
  if (parts.length !== 3) {
    return null;
  }
  const [encodedHeader, encodedPayload, signature] = parts;
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expected = sign(signingInput);
  if (!safeEqualString(signature, expected)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(fromBase64Url(encodedPayload).toString('utf8'));
  } catch (_err) {
    return null;
  }
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  const exp = Number(payload.exp || 0);
  const iat = Number(payload.iat || 0);
  if (!Number.isFinite(exp) || !Number.isFinite(iat)) {
    return null;
  }
  if (exp <= (now - CLOCK_SKEW_SEC)) {
    return null;
  }
  if (iat > (now + CLOCK_SKEW_SEC)) {
    return null;
  }
  if (!payload.sub) {
    return null;
  }
  return {
    email: String(payload.sub),
    name: String(payload.name || ''),
    iat,
    exp
  };
}

module.exports = {
  issueToken,
  verifyToken
};
