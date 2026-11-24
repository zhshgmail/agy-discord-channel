'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  decideInboundAccess,
  isOutboundTargetAllowed,
  loadAccessState,
  lookupGuildPolicy,
} = require('./access');
const { loadConfig } = require('./config');
const {
  checkReplyReceipt,
  enqueueInbound,
  formatDiscordEnvelope,
  markDelivered,
  markDeliveryAttemptError,
  peekPendingQueue,
  readLastInbound,
  readQueueStatus,
  recordReplyReceipt,
  sanitizeControlChars,
  writeFileAtomicDurable,
} = require('./queue');
const {
  acquireReceiverLock,
  deliverToAgySession,
  findAncestorAgyProcess,
  isCurrentReceiverLock,
  releaseReceiverLock,
  resolveSessionRoute,
} = require('./session-route');

const MAX_CHUNK_LIMIT = 2000;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_HISTORY_OUTPUT_BYTES = 60 * 1024;
const MAX_SINGLE_MESSAGE_CHARS = 8192;
const RECENT_SENT_CAP = 300;
const SHUTDOWN_STEP_TIMEOUT_MS = 4000;
const DEFAULT_REST_TIMEOUT_MS = 45000;
const DEFAULT_TRANSFER_TIMEOUT_MS = 60000;

const MIME_BY_EXT = {
  '.c': 'text/plain; charset=utf-8',
  '.cc': 'text/plain; charset=utf-8',
  '.cpp': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.diff': 'text/x-diff; charset=utf-8',
  '.gif': 'image/gif',
  '.gz': 'application/gzip',
  '.h': 'text/plain; charset=utf-8',
  '.hpp': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.log': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.patch': 'text/x-diff; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.py': 'text/x-python; charset=utf-8',
  '.rs': 'text/plain; charset=utf-8',
  '.sh': 'text/x-shellscript; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.tar': 'application/x-tar',
  '.tgz': 'application/gzip',
  '.toml': 'application/toml',
  '.ts': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.xml': 'application/xml',
  '.xz': 'application/x-xz',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.zip': 'application/zip',
};

function settleBounded(promiseFactory, timeoutMs = SHUTDOWN_STEP_TIMEOUT_MS) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    if (typeof timer?.unref === 'function') timer.unref();
  });
  return Promise.race([
    Promise.resolve()
      .then(promiseFactory)
      .then(
        (value) => ({ timedOut: false, value }),
        (error) => ({ timedOut: false, error }),
      ),
    timeout,
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function gatewayResourceSnapshot(client) {
  const mem = process.memoryUsage();
  return {
    rssBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
    heapTotalBytes: mem.heapTotal,
    caches: {
      guilds: client?.guilds?.cache?.size ?? 0,
      channels: client?.channels?.cache?.size ?? 0,
      users: client?.users?.cache?.size ?? 0,
    },
  };
}

function configureNetwork(config, logger) {
  if (config.insecureTls) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }
  const transferTimeoutMs = Math.max(5000, Number(config.transferTimeoutMs) || DEFAULT_TRANSFER_TIMEOUT_MS);
  const poolTimeouts = {
    connectTimeout: 20000,
    headersTimeout: Math.max(45000, transferTimeoutMs),
    bodyTimeout: Math.max(60000, transferTimeoutMs),
    keepAliveTimeout: 10000,
    keepAliveMaxTimeout: 30000,
  };
  let dispatcher = null;
  try {
    const { Agent, ProxyAgent, setGlobalDispatcher } = require('undici');
    if (config.proxyUrl) {
      dispatcher = new ProxyAgent({
        uri: config.proxyUrl,
        ...poolTimeouts,
        requestTls: { rejectUnauthorized: !config.insecureTls },
        proxyTls: { rejectUnauthorized: !config.insecureTls },
      });
      setGlobalDispatcher(dispatcher);
      logger('INFO', 'Configured Discord HTTP proxy');
    } else {
      dispatcher = new Agent({
        ...poolTimeouts,
        ...(config.insecureTls ? { connect: { rejectUnauthorized: false } } : {}),
      });
      if (config.insecureTls) {
        setGlobalDispatcher(dispatcher);
      }
    }
  } catch (err) {
    logger('WARN', 'Failed to configure Discord HTTP dispatcher', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (config.proxyUrl && !('bun' in process.versions)) {
    try {
      process.versions.bun = 'agy-discord-channel';
    } catch {}
  }
  return dispatcher;
}

function getHttpFetch(deps = {}, dispatcher = null) {
  if (typeof deps.fetch === 'function') return deps.fetch;
  try {
    const undici = require('undici');
    if (typeof undici.fetch === 'function') {
      return dispatcher
        ? (url, init = {}) => undici.fetch(url, { ...init, dispatcher })
        : undici.fetch;
    }
  } catch {}
  return globalThis.fetch;
}

function isRetryableTransferError(err) {
  if (!err) return false;
  const name = String(err.name || '');
  const code = String(err.code || err.cause?.code || '');
  const msg = String(err.message || '');
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  if (/ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|fetch failed/i.test(`${code} ${msg}`)) {
    return true;
  }
  return false;
}

async function fetchWithRetry(fetchFn, url, init = {}, timeoutMs = DEFAULT_TRANSFER_TIMEOUT_MS, maxAttempts = 2) {
  let lastError = null;
  const boundedTimeout = Math.max(1000, Number(timeoutMs) || DEFAULT_TRANSFER_TIMEOUT_MS);
  for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`HTTP transfer timed out after ${boundedTimeout}ms`)),
      boundedTimeout,
    );
    if (typeof timer?.unref === 'function') timer.unref();
    try {
      const res = await fetchFn(url, { ...init, signal: controller.signal });
      if (res.status >= 500 && res.status < 600 && attempt < maxAttempts) {
        try {
          await res.arrayBuffer();
        } catch {}
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }
      return res;
    } catch (err) {
      const normalizedErr =
        controller.signal.aborted && controller.signal.reason instanceof Error
          ? controller.signal.reason
          : err instanceof Error
            ? err
            : new Error(String(err));
      lastError = normalizedErr;
      if (attempt < maxAttempts && isRetryableTransferError(err)) {
        continue;
      }
      throw normalizedErr;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('HTTP transfer failed');
}

function inferMimeType(filePath) {
  const lower = path.basename(String(filePath || '')).toLowerCase();
  if (lower.endsWith('.tar.gz')) return 'application/gzip';
  if (lower.endsWith('.tar.xz')) return 'application/x-xz';
  const ext = path.extname(lower);
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

function sanitizeAttachmentFilename(rawName, fallback = 'attachment.bin') {
  const base = path.basename(String(rawName || '').trim());
  const cleaned = base
    .replace(/[\x00-\x1f\x7f/\\:*?"<>|;\[\]]+/g, '_')
    .replace(/^\.+/, '')
    .trim();
  if (!cleaned) return fallback;
  if (cleaned.length <= 120) return cleaned;
  const ext = path.extname(cleaned).slice(0, 20);
  const stem = cleaned.slice(0, Math.max(1, 120 - ext.length));
  return `${stem}${ext}`;
}

function chunkText(text, limit = MAX_CHUNK_LIMIT, mode = 'newline') {
  const str = String(text ?? '');
  if (str.length <= limit) return [str];
  const out = [];
  let rest = str;
  const preferNewline = mode === 'newline' || mode === 'split';
  while (rest.length > limit) {
    let cut = limit;
    if (preferNewline) {
      const para = rest.lastIndexOf('\n\n', limit);
      const line = rest.lastIndexOf('\n', limit);
      const space = rest.lastIndexOf(' ', limit);
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit;
    }
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

function assertSendableFile(filePath, stateDir) {
  let realFile;
  let realState;
  try {
    realFile = fs.realpathSync(filePath);
    realState = fs.realpathSync(stateDir);
  } catch {
    return;
  }
  const inboxDir = path.join(realState, 'inbox');
  if (
    (realFile === realState || realFile.startsWith(realState + path.sep)) &&
    !realFile.startsWith(inboxDir + path.sep)
  ) {
    throw new Error(`Refusing to upload internal channel state file: ${filePath}`);
  }
}

function resolveRealOrNearestParent(targetPath) {
  const abs = path.resolve(String(targetPath));
  let cur = abs;
  const tail = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  const realBase = fs.existsSync(cur) ? fs.realpathSync(cur) : cur;
  return tail.length > 0 ? path.join(realBase, ...tail) : realBase;
}

function assertWritableDownloadDir(dirPath, stateDir) {
  if (!stateDir) return;
  let realDir;
  let realState;
  try {
    realDir = resolveRealOrNearestParent(dirPath);
    realState = resolveRealOrNearestParent(stateDir);
  } catch {
    return;
  }
  const inboxDir = path.join(realState, 'inbox');
  if (
    (realDir === realState || realDir.startsWith(realState + path.sep)) &&
    realDir !== inboxDir &&
    !realDir.startsWith(inboxDir + path.sep)
  ) {
    throw new Error(`Refusing to write downloaded attachments into internal state directory: ${dirPath}`);
  }
}

function prepareUploadFiles(files, stateDir) {
  const rawList = Array.isArray(files) ? files.filter((f) => f !== undefined && f !== null && String(f).trim() !== '') : [];
  if (rawList.length > 10) {
    throw new Error('Discord allows at most 10 attachments per message');
  }
  return rawList.map((rawPath, index) => {
    const filePath = path.resolve(String(rawPath));
    if (!fs.existsSync(filePath)) {
      throw new Error(`Attachment file not found: ${rawPath}`);
    }
    assertSendableFile(filePath, stateDir);
    const st = fs.statSync(filePath);
    if (!st.isFile()) {
      throw new Error(`Attachment path is not a regular file: ${rawPath}`);
    }
    if (st.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Attachment exceeds 25MB limit: ${rawPath}`);
    }
    const buffer = fs.readFileSync(filePath);
    if (buffer.length > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Attachment exceeds 25MB limit: ${rawPath}`);
    }
    const name = sanitizeAttachmentFilename(path.basename(filePath), `attachment-${index + 1}.bin`);
    return {
      index,
      filePath,
      name,
      size: buffer.length,
      contentType: inferMimeType(name),
      buffer,
    };
  });
}

function discordCacheOptions(discord) {
  const Options = discord?.Options;
  if (!Options || typeof Options.cacheWithLimits !== 'function') return {};
  return {
    makeCache: Options.cacheWithLimits({
      ...(Options.DefaultMakeCacheSettings || {}),
      MessageManager: 10,
      ReactionManager: 0,
      ReactionUserManager: 0,
      GuildMemberManager: 8,
      PresenceManager: 0,
      VoiceStateManager: 0,
      ThreadMemberManager: 0,
      UserManager: 48,
    }),
    sweepers: {
      ...(Options.DefaultSweeperSettings || {}),
      messages: { interval: 60, lifetime: 180 },
      threads: { interval: 300, lifetime: 900 },
    },
  };
}

function normalizeDiscordJsMessage(msg, referencedMsg, botUserId, recentSentIds) {
  const isDM = msg.channel?.type === 1 || !msg.guildId;
  const isThread = typeof msg.channel?.isThread === 'function' && msg.channel.isThread();
  const threadParentId = isThread && msg.channel.parentId ? String(msg.channel.parentId) : null;
  const refId = msg.reference?.messageId ? String(msg.reference.messageId) : '';
  const repliedToAuthorId = referencedMsg?.author?.id
    ? String(referencedMsg.author.id)
    : refId && recentSentIds.has(refId)
      ? String(botUserId || '')
      : '';
  const mentionedRoleIds = msg.mentions?.roles
    ? Array.from(msg.mentions.roles.keys()).map(String)
    : [];
  const contentStr = String(msg.content || '');
  const contentMentionsBot = Boolean(
    botUserId && (contentStr.includes(`<@${botUserId}>`) || contentStr.includes(`<@!${botUserId}>`)),
  );
  // Ignore Discord's implicit repliedUser mention on quote-replies unless <@botUserId> is in content
  const mentionsBotUser = Boolean(
    contentMentionsBot ||
      (!refId &&
        botUserId &&
        msg.mentions?.users &&
        typeof msg.mentions.users.has === 'function' &&
        msg.mentions.users.has(botUserId)),
  );
  const attachments = msg.attachments
    ? Array.from(msg.attachments.values()).map((att) => ({
        id: String(att.id),
        name: att.name || String(att.id),
        url: att.url,
        contentType: att.contentType || null,
        size: att.size || 0,
      }))
    : [];

  return {
    source: isDM ? 'dm' : 'guild',
    channelId: String(msg.channelId),
    channelName: msg.channel?.name ? String(msg.channel.name) : isDM ? 'DM' : '',
    threadParentId,
    guildId: msg.guildId ? String(msg.guildId) : null,
    messageId: String(msg.id),
    authorId: String(msg.author?.id || ''),
    authorName: String(msg.author?.username || msg.author?.tag || ''),
    authorIsBot: Boolean(msg.author?.bot),
    mentionsBotUser,
    mentionsEveryone: Boolean(msg.mentions?.everyone),
    mentionedRoleIds,
    isReply: Boolean(refId),
    repliedToMessageId: refId || null,
    repliedToAuthorId,
    createdAt: msg.createdAt ? msg.createdAt.toISOString() : new Date().toISOString(),
    content: String(msg.content || ''),
    attachments,
    botUserId: String(botUserId || ''),
  };
}

function createDiscordService({ initialConfig, logger, deps = {} }) {
  let config = initialConfig || loadConfig();
  const ownerAgy = deps.ownerAgy !== undefined ? deps.ownerAgy : findAncestorAgyProcess();
  const dmChannelUsers = new Map();
  const recentSentIds = new Set();

  let client = null;
  let httpDispatcher = null;
  let myLockRecord = null;
  let gatewayState = {
    started: false,
    connected: false,
    reason: 'initializing',
    botTag: null,
    botId: config.botUserId || null,
    receiverOwned: false,
    receiverHolder: null,
    lastDrainError: null,
    lastDeliveredAt: null,
  };
  let draining = false;
  let shuttingDown = false;
  let drainTimer = null;
  let envWatchTimer = null;
  let approvalTimer = null;

  function verifyStillReceiver() {
    if (!gatewayState.receiverOwned || !myLockRecord) return false;
    const checkFn = deps.isCurrentReceiverLock || isCurrentReceiverLock;
    return checkFn(config.paths, myLockRecord);
  }

  function noteSent(id) {
    if (!id) return;
    recentSentIds.add(String(id));
    if (recentSentIds.size > RECENT_SENT_CAP) {
      const oldest = recentSentIds.values().next().value;
      if (oldest) recentSentIds.delete(oldest);
    }
  }

  function writeHealthSnapshot() {
    try {
      const route = (deps.resolveSessionRoute || resolveSessionRoute)(config, ownerAgy);
      const queue = readQueueStatus(config.paths);
      const payload = {
        updatedAt: new Date().toISOString(),
        instance: config.paths.instance,
        stateDir: config.paths.stateDir,
        pid: process.pid,
        ownerAgyPid: ownerAgy?.pid || null,
        tokenConfigured: config.tokenConfigured,
        gateway: gatewayState,
        resources: gatewayResourceSnapshot(client),
        sessionRoute: {
          ready: route.ready,
          reason: route.reason || null,
          conversationId: route.conversationId || null,
          conversationSource: route.conversationSource || null,
        },
        queue,
      };
      writeFileAtomicDurable(
        config.paths.gatewayHealthPath,
        `${JSON.stringify(payload, null, 2)}\n`,
        0o600,
      );
    } catch {}
  }

  async function drainPendingQueue() {
    if (draining || shuttingDown || !verifyStillReceiver()) return;
    draining = true;
    try {
      const items = peekPendingQueue(config.paths);
      if (items.length === 0) return;

      const route = (deps.resolveSessionRoute || resolveSessionRoute)(config, ownerAgy);
      if (!route.ready) {
        gatewayState.lastDrainError = route.reason || 'route_not_ready';
        return;
      }

      const deliverFn = deps.deliverToAgySession || deliverToAgySession;
      for (const item of items) {
        if (shuttingDown || !verifyStillReceiver()) break;
        const where = item.channelName ? `#${item.channelName}` : item.channelId;
        const title = `Discord: ${item.authorName || item.authorId} (${where})`;
        const envelope = formatDiscordEnvelope(item);
        try {
          await deliverFn(route, title, envelope);
          markDelivered(config.paths, item.channelId, item.messageId, route.conversationId);
          gatewayState.lastDrainError = null;
          gatewayState.lastDeliveredAt = new Date().toISOString();
          logger('INFO', 'Delivered Discord message to AGY session', {
            channelId: item.channelId,
            messageId: item.messageId,
            conversationId: route.conversationId,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          gatewayState.lastDrainError = msg;
          markDeliveryAttemptError(config.paths, item.channelId, item.messageId, msg);
          logger('WARN', 'Deferred Discord message delivery; will retry', {
            channelId: item.channelId,
            messageId: item.messageId,
            error: msg,
          });
          break;
        }
      }
      writeHealthSnapshot();
    } finally {
      draining = false;
    }
  }

  async function checkPairingApprovals() {
    if (!client || !gatewayState.connected || config.staticAccess || !verifyStillReceiver()) return;
    let files;
    try {
      files = fs.readdirSync(config.paths.approvedDir);
    } catch {
      return;
    }
    for (const senderId of files) {
      const file = path.join(config.paths.approvedDir, senderId);
      let dmChannelId = '';
      try {
        dmChannelId = fs.readFileSync(file, 'utf8').trim();
      } catch {
        fs.rmSync(file, { force: true });
        continue;
      }
      if (!dmChannelId) {
        fs.rmSync(file, { force: true });
        continue;
      }
      try {
        const ch = await client.channels.fetch(dmChannelId);
        if (ch && typeof ch.send === 'function') {
          await ch.send('Paired! Your messages now reach this Antigravity session.');
        }
      } catch (err) {
        logger('WARN', 'Failed to send pairing confirmation DM', {
          senderId,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        fs.rmSync(file, { force: true });
      }
    }
  }

  async function handleInboundMessage(msg) {
    try {
      if (shuttingDown || !verifyStillReceiver()) return;
      const botUserId = client?.user?.id || config.botUserId || '';
      if (botUserId && msg.author?.id === botUserId) return;

      let referencedMsg = null;
      if (msg.reference?.messageId && typeof msg.fetchReference === 'function') {
        const refId = String(msg.reference.messageId);
        if (!recentSentIds.has(refId)) {
          try {
            referencedMsg = await msg.fetchReference();
          } catch {}
        }
      }
      if (!verifyStillReceiver()) return;

      const normalized = normalizeDiscordJsMessage(msg, referencedMsg, botUserId, recentSentIds);
      const decision = decideInboundAccess(config.paths.accessPath, normalized, {
        staticAccess: config.staticAccess,
      });

      if (decision.action === 'drop') return;

      if (decision.action === 'pair') {
        const prefix = decision.isResend ? 'Pairing still pending' : 'Pairing required';
        try {
          await msg.reply(
            `${prefix} — run in your Antigravity console:\n\n\`/discord-access pair ${decision.code}\``,
          );
        } catch (err) {
          logger('WARN', 'Failed to send pairing code reply', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      if (normalized.source === 'dm') {
        dmChannelUsers.set(normalized.channelId, normalized.authorId);
      }

      if (msg.channel && typeof msg.channel.sendTyping === 'function') {
        void msg.channel.sendTyping().catch(() => {});
      }
      if (decision.state.ackReaction && typeof msg.react === 'function') {
        void msg.react(decision.state.ackReaction).catch(() => {});
      }

      enqueueInbound(config.paths, normalized);
      await drainPendingQueue();
    } catch (err) {
      logger('ERROR', 'Inbound Discord message handler error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function tryConnectGateway() {
    if (shuttingDown || gatewayState.started) return gatewayState;

    config = typeof config.reload === 'function' ? config.reload() : loadConfig();
    if (config.loginDisabled) {
      gatewayState.reason = 'login_disabled';
      writeHealthSnapshot();
      return gatewayState;
    }
    if (!config.tokenConfigured) {
      gatewayState.reason = 'token_missing';
      writeHealthSnapshot();
      return gatewayState;
    }

    const lock = acquireReceiverLock(config.paths, ownerAgy);
    if (!lock.acquired) {
      gatewayState = {
        ...gatewayState,
        started: false,
        connected: false,
        receiverOwned: false,
        receiverHolder: lock.holder,
        reason: 'another_session_owns_instance',
      };
      logger('WARN', 'Another live AGY session already owns this Discord bot instance', {
        instance: config.paths.instance,
        holderMcpPid: lock.holder?.mcpPid,
        holderAgyPid: lock.holder?.ownerAgyPid,
      });
      writeHealthSnapshot();
      return gatewayState;
    }
    if (lock.reclaimedStalePid) {
      logger('WARN', 'Reclaimed stale Discord receiver lock from dead process', {
        stalePid: lock.reclaimedStalePid,
        instance: config.paths.instance,
      });
    }
    myLockRecord = lock.holder;
    gatewayState.receiverOwned = true;
    gatewayState.receiverHolder = lock.holder;

    httpDispatcher = configureNetwork(config, logger);
    const discord = deps.discord || require('discord.js');
    const { Client, Events, GatewayIntentBits, Partials } = discord;

    const intents = [
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
    ];
    if (config.messageContentIntent !== false) {
      intents.push(GatewayIntentBits.MessageContent);
    }

    const nextClient = new Client({
      intents,
      partials: [Partials.Channel],
      rest: {
        timeout: Math.max(5000, Number(config.restTimeoutMs) || DEFAULT_REST_TIMEOUT_MS),
        retries: Math.max(0, Math.min(Number(config.restRetries ?? 2), 5)),
      },
      ...discordCacheOptions(discord),
    });

    nextClient.on('error', (err) => {
      logger('WARN', 'Discord client error', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    nextClient.on(Events.ClientReady, (readyClient) => {
      gatewayState.connected = true;
      gatewayState.reason = 'connected';
      gatewayState.botTag = readyClient.user?.tag || null;
      gatewayState.botId = readyClient.user?.id || config.botUserId || null;
      logger('INFO', 'Discord gateway connected', {
        botTag: gatewayState.botTag,
        botId: gatewayState.botId,
        instance: config.paths.instance,
      });
      writeHealthSnapshot();
      void drainPendingQueue();
    });

    nextClient.on(Events.MessageCreate, (msg) => {
      void handleInboundMessage(msg);
    });

    try {
      gatewayState.started = true;
      gatewayState.reason = 'connecting';
      await nextClient.login(config.token);
      client = nextClient;
      if (client.user) {
        gatewayState.connected = true;
        gatewayState.reason = 'connected';
        gatewayState.botTag = client.user.tag || null;
        gatewayState.botId = client.user.id || config.botUserId || null;
      }
      writeHealthSnapshot();
      void drainPendingQueue();
      return gatewayState;
    } catch (err) {
      gatewayState.started = false;
      gatewayState.connected = false;
      gatewayState.reason = `login_failed: ${err instanceof Error ? err.message : String(err)}`;
      releaseReceiverLock(config.paths, myLockRecord);
      myLockRecord = null;
      gatewayState.receiverOwned = false;
      await settleBounded(() => nextClient.destroy(), 2000);
      logger('ERROR', 'Discord gateway login failed', { error: gatewayState.reason });
      writeHealthSnapshot();
      return gatewayState;
    }
  }

  async function start() {
    await tryConnectGateway();
    drainTimer = setInterval(() => {
      void drainPendingQueue();
    }, Math.max(250, config.drainIntervalMs));
    if (typeof drainTimer.unref === 'function') drainTimer.unref();

    envWatchTimer = setInterval(() => {
      if (!gatewayState.started && !shuttingDown) {
        const fresh = typeof config.reload === 'function' ? config.reload() : loadConfig();
        if (fresh.tokenConfigured && !fresh.loginDisabled) {
          void tryConnectGateway();
        }
      }
      writeHealthSnapshot();
    }, Math.max(1000, config.envPollIntervalMs));
    if (typeof envWatchTimer.unref === 'function') envWatchTimer.unref();

    approvalTimer = setInterval(() => {
      void checkPairingApprovals();
    }, 4000);
    if (typeof approvalTimer.unref === 'function') approvalTimer.unref();
  }

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    if (drainTimer) clearInterval(drainTimer);
    if (envWatchTimer) clearInterval(envWatchTimer);
    if (approvalTimer) clearInterval(approvalTimer);
    releaseReceiverLock(config.paths, myLockRecord);
    myLockRecord = null;
    gatewayState.receiverOwned = false;
    if (client) {
      const toClose = client;
      client = null;
      await settleBounded(() => toClose.destroy(), SHUTDOWN_STEP_TIMEOUT_MS);
    }
    if (httpDispatcher && typeof httpDispatcher.close === 'function') {
      const dispatcherToClose = httpDispatcher;
      httpDispatcher = null;
      await settleBounded(() => dispatcherToClose.close(), 1000);
    }
  }

  function requireConnectedClient() {
    if (!client || !gatewayState.connected) {
      throw new Error(
        `Discord gateway is not connected (status: ${gatewayState.reason}). ` +
          `Check \`discord_status\` or configure token in ${config.paths.envFile}.`,
      );
    }
    return client;
  }

  async function fetchAllowedChannel(channelId) {
    const activeClient = requireConnectedClient();
    const fallbackId = !channelId ? readLastInbound(config.paths)?.channelId : '';
    const id = String(channelId || fallbackId || '').trim();
    if (!id) throw new Error('chat_id / channel_id is required');
    const ch = await activeClient.channels.fetch(id);
    if (!ch || typeof ch.isTextBased !== 'function' || !ch.isTextBased()) {
      throw new Error(`Discord channel ${id} not found or not text-based`);
    }
    const access = loadAccessState(config.paths.accessPath);
    const botId = activeClient.user?.id || config.botUserId || '';
    const check = isOutboundTargetAllowed(access, ch, botId, dmChannelUsers);
    if (!check.allowed) {
      throw new Error(
        `Discord channel ${id} is not allowlisted (${check.reason}). Use /discord-access to enable it.`,
      );
    }
    return { ch, access, botId, source: check.source };
  }

  async function uploadAndSendCloudChunk({
    activeClient,
    channelId,
    content,
    preparedFiles,
    replyTo,
    useReplyRef,
  }) {
    const httpFetch = getHttpFetch(deps, httpDispatcher);
    const transferTimeoutMs = Math.max(5000, Number(config.transferTimeoutMs) || DEFAULT_TRANSFER_TIMEOUT_MS);

    const reserve = await activeClient.rest.post(`/channels/${channelId}/attachments`, {
      body: {
        files: preparedFiles.map((f, idx) => ({
          id: idx,
          filename: f.name,
          file_size: f.size,
        })),
      },
    });

    const slots = Array.isArray(reserve?.attachments) ? reserve.attachments : [];
    if (slots.length !== preparedFiles.length) {
      throw new Error(
        `Discord Cloud Attachments returned ${slots.length} upload slot(s) for ${preparedFiles.length} file(s)`,
      );
    }

    const uploadedRefs = [];
    for (let idx = 0; idx < preparedFiles.length; idx++) {
      const file = preparedFiles[idx];
      const slot = slots.find((s) => Number(s.id) === idx) || slots[idx];
      if (!slot?.upload_url || !slot?.upload_filename) {
        throw new Error(`Missing upload_url or upload_filename for attachment ${file.name}`);
      }
      const putRes = await fetchWithRetry(
        httpFetch,
        slot.upload_url,
        {
          method: 'PUT',
          headers: {
            'Content-Type': file.contentType,
            'Content-Length': String(file.size),
          },
          body: file.buffer,
        },
        transferTimeoutMs,
        2,
      );
      if (!putRes.ok) {
        throw new Error(`HTTP ${putRes.status} uploading attachment ${file.name} to Discord storage`);
      }
      uploadedRefs.push({
        id: String(idx),
        filename: file.name,
        uploaded_filename: slot.upload_filename,
      });
    }

    const messageBody = {
      ...(content ? { content } : {}),
      tts: false,
      attachments: uploadedRefs,
      ...(useReplyRef
        ? {
            message_reference: {
              message_id: String(replyTo),
              fail_if_not_exists: false,
            },
            allowed_mentions: {
              parse: ['users', 'roles', 'everyone'],
              replied_user: false,
            },
          }
        : {}),
    };

    const created = await activeClient.rest.post(`/channels/${channelId}/messages`, {
      body: messageBody,
    });
    if (!created?.id) {
      throw new Error('Discord message creation after attachment upload returned no message ID');
    }
    return { id: String(created.id) };
  }

  async function sendReply({
    chatId,
    text,
    replyTo,
    files = [],
    followup = false,
    enforceReceipt = true,
  }) {
    const activeClient = requireConnectedClient();
    const { ch, access } = await fetchAllowedChannel(chatId);
    if (typeof ch.send !== 'function') {
      throw new Error(`Discord channel ${chatId} is not sendable`);
    }

    if (enforceReceipt && replyTo && !followup) {
      const existing = checkReplyReceipt(config.paths, String(ch.id), String(replyTo));
      if (existing) {
        return {
          duplicateSuppressed: true,
          sentIds: existing.outboundMessageIds,
          message: `Duplicate reply suppressed for source message ${replyTo} (already sent: ${existing.outboundMessageIds.join(', ')}). Pass followup=true if an additional message is intentional.`,
        };
      }
    }

    const preparedFiles = prepareUploadFiles(files, config.paths.stateDir);
    const bodyText = String(text ?? '');
    if (bodyText.trim().length === 0 && preparedFiles.length === 0) {
      throw new Error('reply requires non-empty text or at least one file in files');
    }

    const limit = Math.max(100, Math.min(access.textChunkLimit || MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT));
    const chunks = bodyText.length > 0 ? chunkText(bodyText, limit, access.chunkMode || 'newline') : [''];
    const replyMode = access.replyToMode || 'first';
    const uploadMode = config.uploadMode || 'auto';
    const sentIds = [];

    for (let i = 0; i < chunks.length; i++) {
      const useReplyRef =
        Boolean(replyTo) &&
        replyMode !== 'off' &&
        (replyMode === 'all' || i === 0);
      const chunkContent = chunks[i];
      const attachNow = i === 0 && preparedFiles.length > 0;

      let sent = null;
      if (
        attachNow &&
        uploadMode !== 'multipart' &&
        typeof activeClient?.rest?.post === 'function'
      ) {
        try {
          sent = await uploadAndSendCloudChunk({
            activeClient,
            channelId: String(ch.id),
            content: chunkContent,
            preparedFiles,
            replyTo,
            useReplyRef,
          });
        } catch (cloudErr) {
          if (uploadMode === 'cloud') {
            throw cloudErr;
          }
          logger('WARN', 'Discord Cloud Attachments upload failed; falling back to buffered multipart send', {
            channelId: String(ch.id),
            error: cloudErr instanceof Error ? cloudErr.message : String(cloudErr),
          });
        }
      }

      if (!sent) {
        const multipartFiles = attachNow
          ? preparedFiles.map((f) => ({
              attachment: f.buffer,
              name: f.name,
              contentType: f.contentType,
            }))
          : undefined;
        sent = await ch.send({
          ...(chunkContent ? { content: chunkContent } : {}),
          ...(multipartFiles ? { files: multipartFiles } : {}),
          ...(useReplyRef
            ? {
                reply: { messageReference: String(replyTo), failIfNotExists: false },
                allowedMentions: { parse: ['users', 'roles', 'everyone'], repliedUser: false },
              }
            : {}),
        });
      }

      noteSent(sent.id);
      sentIds.push(String(sent.id));
    }

    if (replyTo) {
      recordReplyReceipt(config.paths, String(ch.id), String(replyTo), sentIds, bodyText);
    }

    const attSuffix = preparedFiles.length > 0 ? `, attachments: ${preparedFiles.length}` : '';
    return {
      duplicateSuppressed: false,
      sentIds,
      attachmentCount: preparedFiles.length,
      message:
        sentIds.length === 1
          ? `sent (id: ${sentIds[0]}${attSuffix})`
          : `sent ${sentIds.length} chunks (ids: ${sentIds.join(', ')}${attSuffix})`,
    };
  }

  async function fetchMessages({ channelId, limit = 20, before }) {
    const { ch, access, botId, source } = await fetchAllowedChannel(channelId);
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
    const fetchOpts = { limit: boundedLimit };
    if (before) fetchOpts.before = String(before);
    const msgs = await ch.messages.fetch(fetchOpts);
    const ordered = Array.from(msgs.values()).reverse();

    const isThread = typeof ch.isThread === 'function' && ch.isThread();
    const parentId = isThread && ch.parentId ? String(ch.parentId) : '';
    const groupPolicy = source === 'guild' ? lookupGuildPolicy(access, String(ch.id), parentId) : null;

    const visible = ordered.filter((m) => {
      const authorId = String(m.author?.id || '');
      if (!authorId) return false;
      if (authorId === botId) return true;
      if (source === 'dm') return true;
      const allowBots = groupPolicy ? groupPolicy.allowBots : access.allowBots;
      if (m.author?.bot && !allowBots) return false;
      if (groupPolicy && groupPolicy.allowFrom.length > 0 && !groupPolicy.allowFrom.includes(authorId)) {
        return false;
      }
      return true;
    });

    const lines = [];
    let usedBytes = 0;
    let truncatedCursor = '';

    for (const m of visible) {
      const isMe = m.author?.id === botId;
      const botBadge = m.author?.bot && !isMe ? '[bot]' : '';
      const who = isMe ? `me(${m.author?.username || botId})` : `${m.author?.username || m.author?.id}${botBadge}`;
      const ref = m.reference?.messageId ? ` [reply_to:${m.reference.messageId}]` : '';
      let atts = '';
      if (m.attachments?.size > 0) {
        const items = Array.from(m.attachments.values()).map((a) => {
          const safe = sanitizeAttachmentFilename(a.name || a.id, String(a.id));
          const kb = Math.max(1, Math.round((Number(a.size) || 0) / 1024));
          return `${a.id}:${safe} (${kb}KB)`;
        });
        atts = ` +${m.attachments.size}att[${items.join(', ')}]`;
      }
      const rawContent = sanitizeControlChars(String(m.content || '')).slice(0, MAX_SINGLE_MESSAGE_CHARS);
      const cleanText = rawContent.replace(/[\r\n]+/g, ' ⏎ ');
      const line = `[${m.createdAt.toISOString()}] ${who} (user_id:${m.author?.id}): ${cleanText}${ref}  (id: ${m.id}${atts})`;
      const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
      if (lines.length > 0 && usedBytes + lineBytes > MAX_HISTORY_OUTPUT_BYTES) {
        truncatedCursor = String(m.id);
        break;
      }
      lines.push(line);
      usedBytes += lineBytes;
    }

    if (truncatedCursor) {
      lines.push(`[history output capped at 60KB; pass before="${truncatedCursor}" to paginate]`);
    }

    return {
      channelId: String(ch.id),
      channelName: ch.name || 'DM',
      count: lines.length,
      formatted: lines.length > 0 ? lines.join('\n') : '(no messages)',
    };
  }

  async function reactToMessage({ chatId, messageId, emoji }) {
    const { ch } = await fetchAllowedChannel(chatId);
    const msg = await ch.messages.fetch(String(messageId));
    await msg.react(String(emoji));
    return `reacted with ${emoji}`;
  }

  async function editBotMessage({ chatId, messageId, text }) {
    const { ch } = await fetchAllowedChannel(chatId);
    const msg = await ch.messages.fetch(String(messageId));
    const edited = await msg.edit(String(text));
    return `edited (id: ${edited.id})`;
  }

  async function downloadMessageAttachments({
    chatId,
    messageId,
    saveDir,
    attachmentId,
    filename,
  }) {
    const { ch } = await fetchAllowedChannel(chatId);
    const msg = await ch.messages.fetch(String(messageId));
    if (!msg.attachments || msg.attachments.size === 0) {
      return 'message has no attachments';
    }

    const targetDir = saveDir ? path.resolve(String(saveDir)) : config.paths.inboxDir;
    assertWritableDownloadDir(targetDir, config.paths.stateDir);
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });

    const allAttachments = Array.from(msg.attachments.values());
    const wantedId = attachmentId ? String(attachmentId).trim() : '';
    const wantedName = filename ? String(filename).trim() : '';
    const selected = allAttachments.filter((att) => {
      if (wantedId && String(att.id) !== wantedId) return false;
      if (wantedName && String(att.name || '') !== wantedName) return false;
      return true;
    });

    if (selected.length === 0) {
      const available = allAttachments
        .map((att) => `${att.id}:${sanitizeAttachmentFilename(att.name || att.id)}`)
        .join(', ');
      throw new Error(
        `No matching attachment on message ${messageId} (available: ${available || 'none'})`,
      );
    }

    const httpFetch = getHttpFetch(deps, httpDispatcher);
    const transferTimeoutMs = Math.max(5000, Number(config.transferTimeoutMs) || DEFAULT_TRANSFER_TIMEOUT_MS);
    const out = [];

    for (const att of selected) {
      if (Number(att.size) > MAX_ATTACHMENT_BYTES) {
        throw new Error(`Attachment too large (${(att.size / 1024 / 1024).toFixed(1)}MB > 25MB)`);
      }
      if (!att.url) {
        throw new Error(`Attachment ${att.id} has no download URL`);
      }
      const res = await fetchWithRetry(
        httpFetch,
        att.url,
        { method: 'GET' },
        transferTimeoutMs,
        2,
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} downloading attachment ${att.id}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_ATTACHMENT_BYTES) {
        throw new Error(
          `Downloaded attachment exceeds 25MB limit (${(buf.length / 1024 / 1024).toFixed(1)}MB > 25MB)`,
        );
      }
      const rawName = String(att.name || att.id);
      const safeFile = sanitizeAttachmentFilename(rawName, `${att.id}.bin`);
      const dest = path.join(targetDir, `${Date.now()}-${att.id}-${safeFile}`);
      writeFileAtomicDurable(dest, buf, 0o600);
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      const mediaType = att.contentType || inferMimeType(safeFile);
      out.push(
        `  ${dest}  (${safeFile}, ${mediaType}, ${buf.length}B, sha256:${sha256.slice(0, 16)})`,
      );
    }
    return `downloaded ${out.length} attachment(s):\n${out.join('\n')}`;
  }

  async function createDiscordThread({ chatId, name, messageId, autoArchiveDuration = 1440 }) {
    const { ch } = await fetchAllowedChannel(chatId);
    let thread;
    if (messageId) {
      const msg = await ch.messages.fetch(String(messageId));
      thread = await msg.startThread({
        name: String(name).slice(0, 100),
        autoArchiveDuration,
      });
    } else if (ch.threads && typeof ch.threads.create === 'function') {
      thread = await ch.threads.create({
        name: String(name).slice(0, 100),
        autoArchiveDuration,
      });
    } else {
      throw new Error(`Channel ${chatId} does not support thread creation`);
    }
    return {
      threadId: String(thread.id),
      name: thread.name,
      parentId: String(ch.id),
    };
  }

  function getStatus() {
    const route = (deps.resolveSessionRoute || resolveSessionRoute)(config, ownerAgy);
    const access = loadAccessState(config.paths.accessPath);
    const queue = readQueueStatus(config.paths);
    return {
      instance: config.paths.instance,
      stateDir: config.paths.stateDir,
      envFile: config.paths.envFile,
      accessFile: config.paths.accessPath,
      tokenConfigured: config.tokenConfigured,
      proxyConfigured: Boolean(config.proxyUrl),
      gateway: gatewayState,
      resources: gatewayResourceSnapshot(client),
      sessionRoute: {
        ready: route.ready,
        reason: route.reason || null,
        conversationId: route.conversationId || null,
        conversationSource: route.conversationSource || null,
        ownerAgyPid: route.ownerAgyPid || null,
      },
      accessSummary: {
        dmPolicy: access.dmPolicy,
        allowBots: access.allowBots,
        allowFromCount: access.allowFrom.length,
        enabledChannels: Object.keys(access.groups),
        pendingPairingsCount: Object.keys(access.pending).length,
      },
      queue,
    };
  }

  return {
    createDiscordThread,
    downloadMessageAttachments,
    drainPendingQueue,
    editBotMessage,
    fetchMessages,
    getStatus,
    handleInboundMessage,
    reactToMessage,
    sendReply,
    shutdown,
    start,
    tryConnectGateway,
  };
}

module.exports = {
  assertSendableFile,
  assertWritableDownloadDir,
  chunkText,
  createDiscordService,
  gatewayResourceSnapshot,
  inferMimeType,
  normalizeDiscordJsMessage,
  prepareUploadFiles,
  sanitizeAttachmentFilename,
  settleBounded,
};
