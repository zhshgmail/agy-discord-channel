'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolvePaths } = require('./paths');

function stripQuotes(value) {
  const trimmed = String(value).trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const norm = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(norm)) return true;
  if (['0', 'false', 'no', 'off'].includes(norm)) return false;
  return fallback;
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function loadEnvFile(filePath, targetEnv) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {}
  const text = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(normalized);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (targetEnv[key] === undefined) {
      targetEnv[key] = stripQuotes(rawValue);
    }
  }
  return true;
}

function saveEnvKey(filePath, key, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  let lines = [];
  if (fs.existsSync(filePath)) {
    lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  }
  const out = [];
  let replaced = false;
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    const norm = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(norm);
    if (match && match[1] === key) {
      if (value !== null && value !== undefined && value !== '') {
        out.push(`${key}=${value}`);
      }
      replaced = true;
    } else {
      out.push(rawLine);
    }
  }
  if (!replaced && value !== null && value !== undefined && value !== '') {
    if (out.length > 0 && out[out.length - 1] === '') {
      out.splice(out.length - 1, 0, `${key}=${value}`);
    } else {
      out.push(`${key}=${value}`);
    }
  }
  const filtered = out.filter((line, idx, arr) => !(idx === arr.length - 1 && line === ''));
  const content = filtered.length > 0 ? `${filtered.join('\n')}\n` : '';
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function loadConfig(inputEnv = process.env) {
  const rawInputEnv = { ...inputEnv };
  const env = { ...rawInputEnv };
  const initialPaths = resolvePaths(env);
  const networkEnvLoaded = loadEnvFile(initialPaths.networkEnvFile, env);
  const envLoaded = loadEnvFile(initialPaths.envFile, env);
  const paths = resolvePaths(env);

  const token = (env.DISCORD_BOT_TOKEN || env.DISCORD_TOKEN || '').trim();
  const botUserId = (env.DISCORD_BOT_USER_ID || env.DISCORD_BOT_ID || '').trim();
  const proxyUrl = (
    env.DISCORD_PROXY_URL ||
    env.HTTPS_PROXY ||
    env.https_proxy ||
    env.HTTP_PROXY ||
    env.http_proxy ||
    ''
  ).trim();

  const uploadModeRaw = (env.DISCORD_UPLOAD_MODE || 'auto').trim().toLowerCase();
  const uploadMode = ['auto', 'cloud', 'multipart'].includes(uploadModeRaw)
    ? uploadModeRaw
    : 'auto';

  return {
    rawInputEnv,
    reload: () => loadConfig(rawInputEnv),
    env,
    paths,
    envLoaded,
    networkEnvLoaded,
    token,
    tokenConfigured: token.length > 0,
    botUserId,
    proxyUrl,
    insecureTls: parseBool(env.DISCORD_INSECURE_TLS, env.NODE_TLS_REJECT_UNAUTHORIZED === '0'),
    messageContentIntent: parseBool(env.DISCORD_MESSAGE_CONTENT_INTENT, true),
    loginDisabled: parseBool(env.DISCORD_CHANNEL_DISABLE_LOGIN, false),
    staticAccess: env.DISCORD_ACCESS_MODE === 'static',
    drainIntervalMs: parseInteger(env.AGY_DISCORD_DRAIN_INTERVAL_MS, 1000),
    envPollIntervalMs: parseInteger(env.AGY_DISCORD_ENV_POLL_MS, 3000),
    restTimeoutMs: Math.max(5000, parseInteger(env.DISCORD_REST_TIMEOUT_MS, 45000)),
    restRetries: Math.max(0, Math.min(parseInteger(env.DISCORD_REST_RETRIES, 2), 5)),
    transferTimeoutMs: Math.max(5000, parseInteger(env.DISCORD_TRANSFER_TIMEOUT_MS, 60000)),
    uploadMode,
  };
}

module.exports = {
  loadConfig,
  loadEnvFile,
  parseBool,
  parseInteger,
  saveEnvKey,
  stripQuotes,
};
