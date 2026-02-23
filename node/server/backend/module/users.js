'use strict';

const crypto = require('crypto');
const kvs = require('./kvs');
const authToken = require('./auth');

const PASSWORD_SALT = process.env.PASSWORD_SALT || 'rdb-demo-salt';

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(`${PASSWORD_SALT}:${password}`).digest('hex');
}

function getSession(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.slice(7).trim();
  if (!token) {
    return null;
  }
  const verified = authToken.verifyToken(token);
  if (!verified) {
    return null;
  }
  return {
    token,
    session: {
      email: verified.email,
      name: verified.name || ''
    }
  };
}

function logout(token) {
  return !!token;
}

async function register(email, name, password) {
  const normalized = normalizeEmail(email);
  const cleanName = String(name || '').trim();
  if (!normalized || !cleanName || !password) {
    throw new Error('missing fields');
  }

  const password_hash = hashPassword(password);
  try {
    await kvs.createAccount(normalized, cleanName, password_hash);
  } catch (err) {
    if ((err.form && err.form.error === 'exists') || err.status === 409) {
      const e = new Error('user exists');
      e.code = 'exists';
      throw e;
    }
    throw err;
  }

  const token = authToken.issueToken({ email: normalized, name: cleanName });
  return { user: { email: normalized, name: cleanName }, token };
}

async function login(email, password) {
  const normalized = normalizeEmail(email);
  if (!normalized || !password) {
    throw new Error('missing fields');
  }

  let account;
  try {
    account = await kvs.getAccount(normalized);
  } catch (_err) {
    account = null;
  }

  if (!account || !account.id || account.password_hash !== hashPassword(password)) {
    const err = new Error('invalid credentials');
    err.code = 'auth';
    throw err;
  }

  const token = authToken.issueToken({ email: account.id, name: account.name || '' });
  return {
    user: { email: account.id, name: account.name || '' },
    token
  };
}

module.exports = {
  getSession,
  logout,
  register,
  login
};
