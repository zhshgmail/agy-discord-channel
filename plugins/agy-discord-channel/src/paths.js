'use strict';

const os = require('node:os');
const path = require('node:path');

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }
  return '';
}

function expandPath(input, env = process.env) {
  if (!input) return input;
  let value = String(input);
  const home = env.HOME || os.homedir();
  if (value === '~') value = home;
  if (value.startsWith('~/')) value = path.join(home, value.slice(2));
  value = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key) => env[key] || '');
  value = value.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, key) => env[key] || '');
  return path.resolve(value);
}

function normalizeInstance(raw) {
  const value = firstNonEmpty(raw, 'default').toLowerCase();
  const normalized = value.replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'default';
}

function resolvePaths(env = process.env) {
  const home = env.HOME || os.homedir();
  const geminiHome = firstNonEmpty(env.GEMINI_HOME, path.join(home, '.gemini'));
  const instance = normalizeInstance(
    firstNonEmpty(env.AGY_DISCORD_INSTANCE, env.DISCORD_INSTANCE),
  );
  const baseDir = expandPath(
    firstNonEmpty(
      env.AGY_DISCORD_BASE_DIR,
      env.DISCORD_CONFIG_BASE_DIR,
      path.join(geminiHome, 'channels', 'discord'),
    ),
    env,
  );
  const stateDir = expandPath(
    firstNonEmpty(
      env.AGY_DISCORD_STATE_DIR,
      env.DISCORD_STATE_DIR,
      env.DISCORD_CONFIG_DIR,
      path.join(baseDir, instance),
    ),
    env,
  );

  return {
    home,
    geminiHome,
    instance,
    baseDir,
    stateDir,
    envFile: expandPath(firstNonEmpty(env.DISCORD_ENV_FILE, path.join(stateDir, '.env')), env),
    networkEnvFile: expandPath(
      firstNonEmpty(env.DISCORD_NETWORK_ENV_FILE, path.join(stateDir, 'network.env')),
      env,
    ),
    accessPath: expandPath(
      firstNonEmpty(env.DISCORD_ACCESS_FILE, path.join(stateDir, 'access.json')),
      env,
    ),
    approvedDir: path.join(stateDir, 'approved'),
    inboxDir: path.join(stateDir, 'inbox'),
    sessionsDir: path.join(stateDir, 'sessions'),
    receiverLockPath: path.join(stateDir, 'receiver.lock.json'),
    gatewayHealthPath: path.join(stateDir, 'gateway-health.json'),
    lastInboundPath: path.join(stateDir, 'last-inbound.json'),
    deliveryQueuePath: path.join(stateDir, 'pending-delivery.json'),
    replyReceiptDir: path.join(stateDir, 'reply-receipts'),
    tuiEchoStatePath: path.join(stateDir, 'tui-echoed.json'),
  };
}

module.exports = {
  expandPath,
  firstNonEmpty,
  normalizeInstance,
  resolvePaths,
};
