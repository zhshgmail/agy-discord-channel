'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  approvePairingCode,
  denyPairingCode,
  loadAccessState,
  saveAccessState,
} = require('./access');
const { loadConfig, saveEnvKey } = require('./config');
const { readQueueStatus } = require('./queue');
const { recordHookSessionBind } = require('./session-route');

function maskToken(token) {
  if (!token) return '(not set)';
  if (token.length <= 10) return '****';
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

function readStdinSync() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function unescapeXml(str) {
  return String(str ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

function parseAttr(attrText, key) {
  const re = new RegExp(`\\b${key}="([^"]*)"`);
  const m = re.exec(attrText);
  return m ? unescapeXml(m[1]) : '';
}

function extractNewDiscordBanners(transcriptPath, tuiEchoStatePath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];

  let echoedIds = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(tuiEchoStatePath, 'utf8'));
    if (Array.isArray(parsed?.echoedIds)) echoedIds = parsed.echoedIds;
  } catch {}
  const echoedSet = new Set(echoedIds);

  let tailText = '';
  try {
    const stat = fs.statSync(transcriptPath);
    const readSize = Math.min(stat.size, 65536);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
      tailText = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }

  const lines = tailText.split(/\r?\n/).filter(Boolean);
  const banners = [];
  const channelRe = /<channel\s+([^>]*\bsource="discord"[^>]*)>\n?([\s\S]*?)\n?<\/channel>/g;

  for (const line of lines) {
    if (!line.includes('source=\\"discord\\"') && !line.includes('source="discord"')) continue;
    let step;
    try {
      step = JSON.parse(line);
    } catch {
      continue;
    }
    if (step?.source !== 'SYSTEM' || typeof step?.content !== 'string') continue;

    channelRe.lastIndex = 0;
    let match;
    while ((match = channelRe.exec(step.content)) !== null) {
      const attrText = match[1];
      const rawBody = unescapeXml(match[2]).trim();
      const messageId = parseAttr(attrText, 'message_id');
      if (!messageId || echoedSet.has(messageId)) continue;
      if (parseAttr(attrText, 'self_test') === 'true') continue;

      echoedSet.add(messageId);
      echoedIds.push(messageId);

      const channelName = parseAttr(attrText, 'channel_name');
      const chatId = parseAttr(attrText, 'chat_id');
      const threadParentId = parseAttr(attrText, 'thread_parent_id');
      const user = parseAttr(attrText, 'user') || parseAttr(attrText, 'user_id');
      const isBot = parseAttr(attrText, 'is_bot') === 'true';

      const where =
        channelName === 'DM'
          ? 'DM'
          : threadParentId
            ? `Thread #${channelName || chatId}`
            : `#${channelName || chatId}`;
      const badge = isBot ? ' `[BOT]`' : '';
      const quoted = rawBody
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
      banners.push(`💬 **[Discord · ${where}]** **@${user}**${badge} (\`${messageId}\`)\n${quoted}`);
    }
  }

  if (banners.length > 0 && tuiEchoStatePath) {
    try {
      fs.mkdirSync(path.dirname(tuiEchoStatePath), { recursive: true, mode: 0o700 });
      const trimmed = echoedIds.slice(-400);
      const tmp = `${tuiEchoStatePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify({ echoedIds: trimmed }, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, tuiEchoStatePath);
    } catch {}
  }

  return banners;
}

function buildHookResponse(payload = {}, env = process.env, pluginRoot = path.resolve(__dirname, '..')) {
  const config = loadConfig(env);
  const bindRes = recordHookSessionBind(config.paths, payload, env);
  const injectSteps = [];

  const eventName = String(payload?.hookEventName || '');
  if (eventName === 'PreInvocation' && payload?.transcriptPath) {
    const banners = extractNewDiscordBanners(payload.transcriptPath, config.paths.tuiEchoStatePath);
    if (banners.length > 0) {
      injectSteps.push({
        systemMessage: {
          systemMessage: '',
          metadata: {
            user_markdown: banners.join('\n\n'),
          },
        },
      });
    }
  }

  if (
    (eventName === 'SessionStart' || eventName === 'PreInvocation') &&
    bindRes.recorded &&
    (!bindRes.record?.lsAddress || !bindRes.record?.csrfToken)
  ) {
    const bindHelper = path.join(pluginRoot, 'bin', 'agy-discord');
    injectSteps.push({
      systemMessage: {
        systemMessage:
          `[agy-discord-channel] Language Server credentials are not bound yet for this agy session ` +
          `(inbound Discord push delivery is waiting). Run \`${bindHelper} bind-hook </dev/null\` ` +
          `once via \`run_command\` in this turn to bind LS credentials.`,
      },
    });
  }

  return injectSteps.length > 0 ? { injectSteps } : {};
}

function runBindHook(env = process.env) {
  let out = {};
  try {
    const raw = readStdinSync().trim();
    const payload = raw ? JSON.parse(raw) : {};
    const pluginRoot = env.PLUGIN_ROOT || path.resolve(__dirname, '..');
    out = buildHookResponse(payload, env, pluginRoot);
  } catch {}
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function formatStatusReport(config) {
  const access = loadAccessState(config.paths.accessPath);
  const queue = readQueueStatus(config.paths);
  let health = null;
  try {
    health = JSON.parse(fs.readFileSync(config.paths.gatewayHealthPath, 'utf8'));
  } catch {}

  return {
    instance: config.paths.instance,
    stateDir: config.paths.stateDir,
    envFile: config.paths.envFile,
    accessFile: config.paths.accessPath,
    tokenConfigured: config.tokenConfigured,
    tokenPreview: maskToken(config.token),
    botUserId: config.botUserId || health?.gateway?.botId || null,
    proxyUrlConfigured: Boolean(config.proxyUrl),
    access: {
      dmPolicy: access.dmPolicy,
      allowBots: access.allowBots,
      allowFrom: access.allowFrom,
      groups: access.groups,
      mentionPatterns: access.mentionPatterns,
      ackReaction: access.ackReaction,
      replyToMode: access.replyToMode,
      textChunkLimit: access.textChunkLimit,
      chunkMode: access.chunkMode,
      pendingPairings: Object.entries(access.pending).map(([code, p]) => ({
        code,
        senderId: p.senderId,
        senderName: p.senderName,
        expiresInSec: Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000)),
      })),
    },
    queue,
    gatewayHealth: health,
  };
}

function parseFlags(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--no-mention') {
      flags.noMention = true;
    } else if (arg === '--allow-bots') {
      flags.allowBots = true;
    } else if (arg === '--no-bots') {
      flags.allowBots = false;
    } else if (arg === '--allow' && i + 1 < args.length) {
      flags.allow = args[++i];
    } else if (arg === '--from' && i + 1 < args.length) {
      flags.from = args[++i];
    } else if (arg === '--bot-id' && i + 1 < args.length) {
      flags.botId = args[++i];
    } else if (arg === '--role-id' && i + 1 < args.length) {
      flags.roleId = args[++i];
    } else if (arg === '--proxy' && i + 1 < args.length) {
      flags.proxy = args[++i];
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function handleAccessCommand(config, subArgs) {
  const { positional, flags } = parseFlags(subArgs);
  const sub = positional[0] || 'status';
  const access = loadAccessState(config.paths.accessPath);

  if (sub === 'status') {
    process.stdout.write(`${JSON.stringify(formatStatusReport(config).access, null, 2)}\n`);
    return;
  }

  if (sub === 'pair') {
    const code = positional[1];
    if (!code) throw new Error('Usage: agy-discord access pair <6-char-code>');
    const res = approvePairingCode(config.paths, code);
    if (!res.ok) throw new Error(res.reason);
    process.stdout.write(`Approved sender ${res.senderId} (${res.senderName || 'DM'}).\n`);
    return;
  }

  if (sub === 'deny') {
    const code = positional[1];
    if (!code) throw new Error('Usage: agy-discord access deny <6-char-code>');
    const res = denyPairingCode(config.paths, code);
    if (!res.ok) throw new Error(res.reason);
    process.stdout.write(`Denied pairing code ${code} (sender ${res.senderId}).\n`);
    return;
  }

  if (sub === 'allow') {
    const id = positional[1];
    if (!id) throw new Error('Usage: agy-discord access allow <user_or_bot_snowflake>');
    if (!access.allowFrom.includes(id)) access.allowFrom.push(id);
    saveAccessState(config.paths.accessPath, access);
    process.stdout.write(`Added ${id} to allowFrom.\n`);
    return;
  }

  if (sub === 'remove') {
    const id = positional[1];
    if (!id) throw new Error('Usage: agy-discord access remove <user_or_bot_snowflake>');
    access.allowFrom = access.allowFrom.filter((x) => x !== id);
    saveAccessState(config.paths.accessPath, access);
    process.stdout.write(`Removed ${id} from allowFrom.\n`);
    return;
  }

  if (sub === 'policy') {
    const mode = positional[1];
    if (!['pairing', 'allowlist', 'closed', 'open', 'disabled'].includes(mode)) {
      throw new Error('Usage: agy-discord access policy <pairing|allowlist|closed|open|disabled>');
    }
    access.dmPolicy = mode;
    saveAccessState(config.paths.accessPath, access);
    process.stdout.write(`Set dmPolicy = ${mode}.\n`);
    return;
  }

  if (sub === 'allow-bots') {
    const val = positional[1];
    if (!['true', 'false', 'on', 'off'].includes(String(val || '').toLowerCase())) {
      throw new Error('Usage: agy-discord access allow-bots <true|false>');
    }
    const enabled = ['true', 'on'].includes(val.toLowerCase());
    access.allowBots = enabled;
    for (const grp of Object.values(access.groups)) {
      grp.allowBots = enabled;
    }
    saveAccessState(config.paths.accessPath, access);
    process.stdout.write(`Set allowBots = ${enabled} (including existing groups).\n`);
    return;
  }

  if (sub === 'group') {
    const action = positional[1];
    const channelId = positional[2];
    if (action === 'add' && channelId) {
      const allowFrom = flags.allow
        ? flags.allow
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : access.groups[channelId]?.allowFrom || [];
      access.groups[channelId] = {
        requireMention: !flags.noMention,
        allowFrom,
        allowBots: flags.allowBots !== undefined ? flags.allowBots : access.allowBots,
      };
      saveAccessState(config.paths.accessPath, access);
      process.stdout.write(
        `Enabled channel ${channelId} (requireMention=${!flags.noMention}, allowBots=${access.groups[channelId].allowBots}). Threads in this channel inherit access automatically.\n`,
      );
      return;
    }
    if ((action === 'rm' || action === 'remove') && channelId) {
      delete access.groups[channelId];
      saveAccessState(config.paths.accessPath, access);
      process.stdout.write(`Disabled channel ${channelId}.\n`);
      return;
    }
    throw new Error(
      'Usage: agy-discord access group <add|rm> <channel_id> [--no-mention] [--allow-bots] [--allow id1,id2]',
    );
  }

  if (sub === 'set') {
    const key = positional[1];
    const rawVal = positional[2];
    if (!key || rawVal === undefined) {
      throw new Error(
        'Usage: agy-discord access set <ackReaction|replyToMode|textChunkLimit|chunkMode|mentionPatterns> <value>',
      );
    }
    if (key === 'ackReaction') {
      access.ackReaction = rawVal;
    } else if (key === 'replyToMode') {
      access.replyToMode = rawVal;
    } else if (key === 'textChunkLimit') {
      access.textChunkLimit = Number.parseInt(rawVal, 10);
    } else if (key === 'chunkMode') {
      access.chunkMode = rawVal;
    } else if (key === 'mentionPatterns') {
      access.mentionPatterns = JSON.parse(rawVal);
    } else {
      throw new Error(`Unsupported access key: ${key}`);
    }
    const saved = saveAccessState(config.paths.accessPath, access);
    process.stdout.write(`Updated ${key} = ${JSON.stringify(saved[key])}.\n`);
    return;
  }

  throw new Error(`Unknown access subcommand: ${sub}`);
}

function handleConfigureCommand(config, subArgs) {
  const { positional, flags } = parseFlags(subArgs);
  const first = positional[0];

  if (!first || first === 'status') {
    process.stdout.write(`${JSON.stringify(formatStatusReport(config), null, 2)}\n`);
    return;
  }

  if (first === 'clear') {
    saveEnvKey(config.paths.envFile, 'DISCORD_BOT_TOKEN', '');
    process.stdout.write(`Cleared DISCORD_BOT_TOKEN in ${config.paths.envFile}.\n`);
    return;
  }

  saveEnvKey(config.paths.envFile, 'DISCORD_BOT_TOKEN', first.trim());
  if (flags.botId) {
    saveEnvKey(config.paths.envFile, 'DISCORD_BOT_USER_ID', flags.botId.trim());
  }
  if (flags.proxy) {
    saveEnvKey(config.paths.envFile, 'DISCORD_PROXY_URL', flags.proxy.trim());
  }
  const updated = loadConfig();
  process.stdout.write(
    `Saved token (${maskToken(updated.token)}) to ${updated.paths.envFile} (mode 0600).\n` +
      `Any running Antigravity session for instance "${updated.paths.instance}" will hot-connect automatically within ~3 seconds.\n`,
  );
}

function handleImportAccess(config, subArgs) {
  const { flags } = parseFlags(subArgs);
  const sourcePath = flags.from;
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error(
      'Usage: agy-discord import-access --from <path/to/access.json> [--bot-id <id>] [--role-id <id>]',
    );
  }
  const imported = loadAccessState(sourcePath);
  const current = loadAccessState(config.paths.accessPath);

  const mergedAllowFrom = Array.from(new Set([...current.allowFrom, ...imported.allowFrom]));
  if (flags.botId && !mergedAllowFrom.includes(flags.botId)) {
    mergedAllowFrom.push(flags.botId);
  }

  const patterns = [];
  if (flags.roleId) patterns.push(`<@&${flags.roleId}>`);
  if (flags.botId) patterns.push(`<@${flags.botId}>`);
  if (imported.mentionPatterns.includes('@everyone')) patterns.push('@everyone');
  for (const p of current.mentionPatterns) {
    if (!patterns.includes(p)) patterns.push(p);
  }

  const mergedGroups = { ...current.groups };
  for (const [chId, grp] of Object.entries(imported.groups)) {
    const grpAllow = Array.from(new Set([...(grp.allowFrom || []), ...(flags.botId ? [flags.botId] : [])]));
    mergedGroups[chId] = {
      requireMention: grp.requireMention !== false,
      allowBots: grp.allowBots === true || imported.allowBots === true,
      allowFrom: grpAllow,
    };
  }

  const next = saveAccessState(config.paths.accessPath, {
    ...current,
    dmPolicy: imported.dmPolicy || current.dmPolicy,
    allowBots: imported.allowBots || current.allowBots,
    allowFrom: mergedAllowFrom,
    groups: mergedGroups,
    mentionPatterns: patterns,
  });

  if (flags.botId) {
    saveEnvKey(config.paths.envFile, 'DISCORD_BOT_USER_ID', flags.botId);
  }

  process.stdout.write(
    `Imported access policy into ${config.paths.accessPath}:\n` +
      `  allowBots: ${next.allowBots}\n` +
      `  allowFrom: ${next.allowFrom.length} IDs\n` +
      `  groups: ${Object.keys(next.groups).join(', ') || '(none)'}\n` +
      `  mentionPatterns: ${JSON.stringify(next.mentionPatterns)}\n`,
  );
}

function printHelp() {
  process.stdout.write(
    [
      'Usage: agy-discord <command> [options]',
      '',
      'Commands:',
      '  status | doctor                            Show bot, session binding, queue, and access status',
      '  configure [<bot_token>|clear] [--bot-id X] [--proxy URL]',
      '                                             Save or clear DISCORD_BOT_TOKEN in state .env',
      '  access [status]                            Show access policy',
      '  access pair <code>                         Approve a 6-char DM pairing code',
      '  access deny <code>                         Reject a pending pairing code',
      '  access allow <snowflake>                   Add user/bot ID to allowFrom',
      '  access remove <snowflake>                  Remove user/bot ID from allowFrom',
      '  access policy <pairing|allowlist|open|disabled>',
      '  access allow-bots <true|false>             Allow peer Discord bots (with loop guard)',
      '  access group add <channel_id> [--no-mention] [--allow-bots] [--allow id1,id2]',
      '  access group rm <channel_id>',
      '  access set <key> <value>',
      '  import-access --from <access.json> [--bot-id <id>] [--role-id <id>]',
      '                                             Import team allowlist & channels from Claude/Codex access.json',
      '  bind-hook                                  Internal SessionStart/PreInvocation hook handler',
      '',
      'Environment:',
      '  DISCORD_INSTANCE=<name>                    Select bot instance (default: "default" -> ~/.gemini/channels/discord/default)',
      '  DISCORD_STATE_DIR=<dir>                    Explicit state directory override',
      '',
    ].join('\n'),
  );
}

function main(argv = process.argv.slice(2)) {
  const cmd = argv[0] || 'status';
  if (cmd === 'bind-hook') {
    runBindHook(process.env);
    return;
  }
  if (cmd === '-h' || cmd === '--help' || cmd === 'help') {
    printHelp();
    return;
  }
  const config = loadConfig();
  if (cmd === 'status' || cmd === 'doctor') {
    process.stdout.write(`${JSON.stringify(formatStatusReport(config), null, 2)}\n`);
    return;
  }
  if (cmd === 'configure') {
    handleConfigureCommand(config, argv.slice(1));
    return;
  }
  if (cmd === 'access') {
    handleAccessCommand(config, argv.slice(1));
    return;
  }
  if (cmd === 'import-access') {
    handleImportAccess(config, argv.slice(1));
    return;
  }
  throw new Error(`Unknown command: ${cmd}. Run \`agy-discord --help\`.`);
}

module.exports = {
  buildHookResponse,
  extractNewDiscordBanners,
  formatStatusReport,
  main,
  runBindHook,
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`agy-discord: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
