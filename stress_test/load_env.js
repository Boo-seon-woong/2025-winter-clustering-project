'use strict';

const fs = require('fs');
const path = require('path');

function stripQuotes(value) {
  if (!value) return value;
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith('\'') && v.endsWith('\''))) {
    return v.slice(1, -1);
  }
  return v;
}

function loadDotEnv(filePath) {
  const target = filePath || path.resolve(__dirname, '.env');
  if (!fs.existsSync(target)) {
    return;
  }
  const text = fs.readFileSync(target, 'utf8');
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = stripQuotes(line.slice(idx + 1));
    if (!key) continue;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

module.exports = {
  loadDotEnv
};

