'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const VALID_DM_POLICIES = new Set(['pairing', 'allowlist', 'closed', 'open', 'disabled']);
const VALID_REPLY_MODES = new Set(['first', 'all', 'off', 'reply']);
const VALID_CHUNK_MODES = new Set(['newline', 'length', 'split']);
const GUILD_THREAD_TYPES = new Set([10, 11, 12]);
const MAX_PENDING_PAIRINGS = 3;
const PAIRING_TTL_MS = 60 * 60 * 1000;

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function defaultAccessState() {
  return {
    version: 1,
    dmPolicy: 'pairing',
    allowBots: false,
    allowFrom: [],
    groups: {},
    pending: {},
    mentionPatterns: [],
    ackReaction: '👀',
    replyToMode: 'first',
    textChunkLimit: 2000,
    chunkMode: 'newline',
  };
}

function normalizeAccessState(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return defaultAccessState();
  }
  const defaults = defaultAccessState();
  const dmPolicy = VALID_DM_POLICIES.has(payload.dmPolicy) ? payload.dmPolicy : defaults.dmPolicy;
  const allowBots = payload.allowBots === true;
  const allowFrom = asStringArray(payload.allowFrom);
  const mentionPatterns = asStringArray(payload.mentionPatterns);
  const ackReaction = typeof payload.ackReaction === 'string' ? payload.ackReaction : defaults.ackReaction;
  const replyToMode = VALID_REPLY_MODES.has(payload.replyToMode) ? payload.replyToMode : defaults.replyToMode;
  const rawLimit = Number.isInteger(payload.textChunkLimit) ? payload.textChunkLimit : defaults.textChunkLimit;
  const textChunkLimit = Math.max(100, Math.min(2000, rawLimit));
  const chunkMode = VALID_CHUNK_MODES.has(payload.chunkMode) ? payload.chunkMode : defaults.chunkMode;

  const groups = {};
  if (payload.groups && typeof payload.groups === 'object' && !Array.isArray(payload.groups)) {
    for (const [channelId, rawGroup] of Object.entries(payload.groups)) {
      if (!rawGroup || typeof rawGroup !== 'object' || Array.isArray(rawGroup)) continue;
      groups[String(channelId).trim()] = {
        requireMention: rawGroup.requireMention !== false,
        allowFrom: asStringArray(rawGroup.allowFrom),
        allowBots: typeof rawGroup.allowBots === 'boolean' ? rawGroup.allowBots : allowBots,
      };
    }
  }

  const pending = {};
  if (payload.pending && typeof payload.pending === 'object' && !Array.isArray(payload.pending)) {
    for (const [code, entry] of Object.entries(payload.pending)) {
      if (!entry || typeof entry !== 'object') continue;
      if (typeof entry.senderId !== 'string' || typeof entry.chatId !== 'string') continue;
      pending[code] = {
        senderId: entry.senderId,
        senderName: typeof entry.senderName === 'string' ? entry.senderName : '',
        chatId: entry.chatId,
        createdAt: Number(entry.createdAt) || 0,
        expiresAt: Number(entry.expiresAt) || 0,
        replies: Number(entry.replies) || 1,
      };
    }
  }

  return {
    version: Number.isInteger(payload.version) ? payload.version : 1,
    dmPolicy,
    allowBots,
    allowFrom,
    groups,
    pending,
    mentionPatterns,
    ackReaction,
    replyToMode,
    textChunkLimit,
    chunkMode,
  };
}

function loadAccessState(accessPath) {
  try {
    const raw = fs.readFileSync(accessPath, 'utf8');
    return normalizeAccessState(JSON.parse(raw));
  } catch (err) {
    if (err && err.code === 'ENOENT') return defaultAccessState();
    try {
      fs.renameSync(accessPath, `${accessPath}.corrupt-${Date.now()}`);
    } catch {}
    return defaultAccessState();
  }
}

function saveAccessState(accessPath, state) {
  const normalized = normalizeAccessState(state);
  fs.mkdirSync(path.dirname(accessPath), { recursive: true, mode: 0o700 });
  const tmp = `${accessPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, accessPath);
  return normalized;
}

function pruneExpiredPending(state, now = Date.now()) {
  let changed = false;
  for (const [code, entry] of Object.entries(state.pending || {})) {
    if (!entry || entry.expiresAt < now) {
      delete state.pending[code];
      changed = true;
    }
  }
  return changed;
}

function mentionsBot(message, botUserId, patterns = []) {
  if (message.mentionsBotUser === true) return true;
  if (message.mentionsEveryone === true) return true;
  const text = String(message.content || '');
  if (botUserId && (text.includes(`<@${botUserId}>`) || text.includes(`<@!${botUserId}>`))) {
    return true;
  }
  if (/(?:^|\s)(?:@everyone|@here)(?=$|\s|[^\w])/.test(text)) {
    return true;
  }
  const mentionedRoleIds = Array.isArray(message.mentionedRoleIds) ? message.mentionedRoleIds : [];
  for (const pattern of patterns) {
    const roleMatch = /^<@&(\d+)>$/.exec(pattern.trim());
    if (roleMatch && mentionedRoleIds.includes(roleMatch[1])) {
      return true;
    }
    try {
      if (new RegExp(pattern, 'i').test(text)) return true;
    } catch {}
  }
  return false;
}

function lookupGuildPolicy(state, channelId, threadParentId) {
  const ch = String(channelId || '');
  const parent = String(threadParentId || '');
  if (ch && Object.hasOwn(state.groups, ch)) {
    return state.groups[ch];
  }
  if (parent && Object.hasOwn(state.groups, parent)) {
    return state.groups[parent];
  }
  const wildcard = state.groups['*'];
  if (!wildcard) return null;
  const allowFrom = wildcard.allowFrom.length > 0 ? wildcard.allowFrom : state.allowFrom;
  return allowFrom.length > 0 ? { ...wildcard, allowFrom } : null;
}

function decideInboundAccess(accessPath, message, options = {}) {
  const now = options.now ?? Date.now();
  const staticAccess = options.staticAccess === true;
  const state = options.preloadedState ? normalizeAccessState(options.preloadedState) : loadAccessState(accessPath);

  if (!staticAccess && pruneExpiredPending(state, now) && accessPath) {
    saveAccessState(accessPath, state);
  }

  if (state.dmPolicy === 'disabled') {
    return { action: 'drop', reason: 'policy_disabled', state };
  }

  const botUserId = String(message.botUserId || '');
  if (botUserId && message.authorId === botUserId) {
    return { action: 'drop', reason: 'self_message', state };
  }

  if (message.source === 'dm') {
    if (message.authorIsBot && !state.allowBots && !state.allowFrom.includes(message.authorId)) {
      return { action: 'drop', reason: 'dm_bot_denied', state };
    }
    if (state.dmPolicy === 'open') {
      return { action: 'deliver', reason: 'dm_open', state };
    }
    if (state.allowFrom.includes(message.authorId)) {
      return { action: 'deliver', reason: 'dm_allowlisted', state };
    }
    if (state.dmPolicy === 'allowlist' || state.dmPolicy === 'closed' || staticAccess) {
      return { action: 'drop', reason: 'dm_not_allowlisted', state };
    }

    // Pairing mode
    for (const [code, entry] of Object.entries(state.pending)) {
      if (entry.senderId === message.authorId) {
        if ((entry.replies ?? 1) >= 2) {
          return { action: 'drop', reason: 'dm_pairing_throttled', state };
        }
        entry.replies = (entry.replies ?? 1) + 1;
        if (accessPath) saveAccessState(accessPath, state);
        return { action: 'pair', code, isResend: true, reason: 'dm_pairing_resend', state };
      }
    }
    if (Object.keys(state.pending).length >= MAX_PENDING_PAIRINGS) {
      return { action: 'drop', reason: 'dm_pairing_cap_reached', state };
    }
    const code = crypto.randomBytes(3).toString('hex');
    state.pending[code] = {
      senderId: message.authorId,
      senderName: message.authorName || '',
      chatId: message.channelId,
      createdAt: now,
      expiresAt: now + PAIRING_TTL_MS,
      replies: 1,
    };
    if (accessPath) saveAccessState(accessPath, state);
    return { action: 'pair', code, isResend: false, reason: 'dm_pairing_created', state };
  }

  // Guild channel or thread
  const group = lookupGuildPolicy(state, message.channelId, message.threadParentId);
  if (!group) {
    return { action: 'drop', reason: 'guild_channel_not_enabled', state };
  }
  const allowBots = typeof group.allowBots === 'boolean' ? group.allowBots : state.allowBots;
  if (message.authorIsBot && !allowBots) {
    return { action: 'drop', reason: 'bot_author_denied', state };
  }
  if (group.allowFrom.length > 0 && !group.allowFrom.includes(message.authorId)) {
    return { action: 'drop', reason: 'guild_sender_denied', state };
  }

  const explicitlyMentioned = mentionsBot(message, botUserId, state.mentionPatterns);
  const isReply = message.isReply === true || Boolean(message.repliedToMessageId);
  const replyToBot = Boolean(botUserId && message.repliedToAuthorId === botUserId);

  // Critical anti-loop rule: a peer bot replying to us MUST explicitly @mention us
  // in the current message body, otherwise two bots would reply to each other forever.
  if (message.authorIsBot && isReply && !explicitlyMentioned) {
    return { action: 'drop', reason: 'guild_bot_reply_mention_required', state };
  }

  const humanReplyToBot = !message.authorIsBot && replyToBot;
  if (group.requireMention && !explicitlyMentioned && !humanReplyToBot) {
    return { action: 'drop', reason: 'guild_mention_required', state };
  }

  return { action: 'deliver', reason: 'guild_allowed', state };
}

function isOutboundTargetAllowed(state, target, botUserId = '', dmChannelUsers = new Map()) {
  if (!target || typeof target !== 'object') {
    return { allowed: false, reason: 'invalid_channel' };
  }
  if (state.dmPolicy === 'disabled') {
    return { allowed: false, reason: 'policy_disabled' };
  }
  // Discord ChannelType.DM === 1
  if (target.type === 1 || (!target.guildId && target.isDM)) {
    if (state.dmPolicy === 'open') return { allowed: true, source: 'dm' };
    const recipientId =
      target.recipientId ||
      target.recipient?.id ||
      dmChannelUsers.get(String(target.id || '')) ||
      '';
    if (recipientId && state.allowFrom.includes(String(recipientId))) {
      return { allowed: true, source: 'dm' };
    }
    return { allowed: false, reason: 'dm_recipient_not_allowlisted' };
  }

  const isThread =
    (typeof target.isThread === 'function' && target.isThread()) ||
    GUILD_THREAD_TYPES.has(target.type);
  const parentId = isThread ? String(target.parentId || '') : '';
  const group = lookupGuildPolicy(state, String(target.id || ''), parentId);
  if (!group) {
    return { allowed: false, reason: 'guild_channel_not_enabled' };
  }
  return { allowed: true, source: 'guild' };
}

function approvePairingCode(paths, code, now = Date.now()) {
  const cleanCode = String(code || '').trim().toLowerCase();
  const state = loadAccessState(paths.accessPath);
  pruneExpiredPending(state, now);
  const entry = state.pending[cleanCode];
  if (!entry) {
    saveAccessState(paths.accessPath, state);
    return { ok: false, reason: `Pairing code "${cleanCode}" not found or expired.` };
  }
  if (!state.allowFrom.includes(entry.senderId)) {
    state.allowFrom.push(entry.senderId);
  }
  delete state.pending[cleanCode];
  saveAccessState(paths.accessPath, state);

  fs.mkdirSync(paths.approvedDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(paths.approvedDir, entry.senderId), `${entry.chatId}\n`, {
    mode: 0o600,
  });
  return {
    ok: true,
    senderId: entry.senderId,
    senderName: entry.senderName,
    chatId: entry.chatId,
  };
}

function denyPairingCode(paths, code) {
  const cleanCode = String(code || '').trim().toLowerCase();
  const state = loadAccessState(paths.accessPath);
  if (!state.pending[cleanCode]) {
    return { ok: false, reason: `Pairing code "${cleanCode}" not found.` };
  }
  const removed = state.pending[cleanCode];
  delete state.pending[cleanCode];
  saveAccessState(paths.accessPath, state);
  return { ok: true, senderId: removed.senderId };
}

module.exports = {
  approvePairingCode,
  asStringArray,
  decideInboundAccess,
  defaultAccessState,
  denyPairingCode,
  isOutboundTargetAllowed,
  loadAccessState,
  lookupGuildPolicy,
  mentionsBot,
  normalizeAccessState,
  pruneExpiredPending,
  saveAccessState,
};
