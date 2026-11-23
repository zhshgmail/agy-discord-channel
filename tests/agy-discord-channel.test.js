'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { resolvePaths } = require('../plugins/agy-discord-channel/src/paths');
const { loadConfig, saveEnvKey } = require('../plugins/agy-discord-channel/src/config');
const {
  approvePairingCode,
  decideInboundAccess,
  isOutboundTargetAllowed,
  loadAccessState,
  saveAccessState,
} = require('../plugins/agy-discord-channel/src/access');
const {
  checkReplyReceipt,
  enqueueInbound,
  formatDiscordEnvelope,
  markDelivered,
  peekPendingQueue,
  readQueueStatus,
  recordReplyReceipt,
  sanitizeControlChars,
} = require('../plugins/agy-discord-channel/src/queue');
const {
  acquireReceiverLock,
  deliverToAgySession,
  discoverConversationFromProcFd,
  isCurrentReceiverLock,
  recordHookSessionBind,
  releaseReceiverLock,
  resolveSessionRoute,
} = require('../plugins/agy-discord-channel/src/session-route');
const {
  assertSendableFile,
  chunkText,
  createDiscordService,
} = require('../plugins/agy-discord-channel/src/discord-gateway');
const { handleJsonRpcMessage } = require('../plugins/agy-discord-channel/src/mcp-server');
const { extractNewDiscordBanners } = require('../plugins/agy-discord-channel/src/cli');

function makeTempState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-discord-test-'));
  const paths = resolvePaths({ HOME: dir, DISCORD_STATE_DIR: path.join(dir, 'state') });
  return { dir, paths };
}

test('paths & config: loads .env and saves keys with mode 0600', () => {
  const { dir, paths } = makeTempState();
  try {
    saveEnvKey(paths.envFile, 'DISCORD_BOT_TOKEN', 'MTIzTestToken9999');
    saveEnvKey(paths.envFile, 'DISCORD_BOT_USER_ID', '999000111222333444');
    const stat = fs.statSync(paths.envFile);
    assert.equal(stat.mode & 0o777, 0o600);

    const cfg = loadConfig({ HOME: dir, DISCORD_STATE_DIR: paths.stateDir });
    assert.equal(cfg.tokenConfigured, true);
    assert.equal(cfg.token, 'MTIzTestToken9999');
    assert.equal(cfg.botUserId, '999000111222333444');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('access: DM pairing workflow, throttling, and approval marker', () => {
  const { dir, paths } = makeTempState();
  try {
    const dmMsg = {
      source: 'dm',
      channelId: 'dm-chan-1',
      messageId: 'm-1',
      authorId: 'user-100',
      authorName: 'alice',
      authorIsBot: false,
      botUserId: 'bot-1',
    };

    // 1st DM -> creates pairing code
    const d1 = decideInboundAccess(paths.accessPath, dmMsg, { now: 1000 });
    assert.equal(d1.action, 'pair');
    assert.equal(d1.isResend, false);
    assert.match(d1.code, /^[0-9a-f]{6}$/);

    // 2nd DM -> resends once
    const d2 = decideInboundAccess(paths.accessPath, dmMsg, { now: 2000 });
    assert.equal(d2.action, 'pair');
    assert.equal(d2.isResend, true);
    assert.equal(d2.code, d1.code);

    // 3rd DM -> throttled (dropped silently)
    const d3 = decideInboundAccess(paths.accessPath, dmMsg, { now: 3000 });
    assert.equal(d3.action, 'drop');

    // Approve code -> writes approved/<senderId> and allows next DM
    const approved = approvePairingCode(paths, d1.code, 4000);
    assert.equal(approved.ok, true);
    assert.equal(approved.senderId, 'user-100');
    assert.equal(
      fs.readFileSync(path.join(paths.approvedDir, 'user-100'), 'utf8').trim(),
      'dm-chan-1',
    );

    const d4 = decideInboundAccess(paths.accessPath, dmMsg, { now: 5000 });
    assert.equal(d4.action, 'deliver');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('access: guild threads inherit parent channel policy + peer bot loop guard', () => {
  const { dir, paths } = makeTempState();
  try {
    saveAccessState(paths.accessPath, {
      dmPolicy: 'allowlist',
      allowBots: true,
      allowFrom: ['human-1', 'peer-bot-2'],
      mentionPatterns: ['<@&777888999>'],
      groups: {
        'parent-chan-1': {
          requireMention: true,
          allowBots: true,
          allowFrom: ['human-1', 'peer-bot-2'],
        },
      },
    });

    // Thread under parent-chan-1 with role mention from peer bot -> DELIVER
    const botRoleMention = decideInboundAccess(paths.accessPath, {
      source: 'guild',
      channelId: 'thread-555',
      threadParentId: 'parent-chan-1',
      messageId: 'm-10',
      authorId: 'peer-bot-2',
      authorIsBot: true,
      content: 'Hey <@&777888999> can you check tiling?',
      mentionedRoleIds: ['777888999'],
      isReply: false,
      botUserId: 'my-bot-9',
    });
    assert.equal(botRoleMention.action, 'deliver');

    // Peer bot replying to my-bot-9 WITHOUT explicit @mention -> DROP (anti-loop guard!)
    const botUnmentionedReply = decideInboundAccess(paths.accessPath, {
      source: 'guild',
      channelId: 'thread-555',
      threadParentId: 'parent-chan-1',
      messageId: 'm-11',
      authorId: 'peer-bot-2',
      authorIsBot: true,
      content: 'Got it, receipt confirmed.',
      isReply: true,
      repliedToMessageId: 'm-9',
      repliedToAuthorId: 'my-bot-9',
      botUserId: 'my-bot-9',
    });
    assert.equal(botUnmentionedReply.action, 'drop');
    assert.equal(botUnmentionedReply.reason, 'guild_bot_reply_mention_required');

    // Human replying to my-bot-9 WITHOUT repeating @mention -> DELIVER
    const humanImplicitReply = decideInboundAccess(paths.accessPath, {
      source: 'guild',
      channelId: 'thread-555',
      threadParentId: 'parent-chan-1',
      messageId: 'm-12',
      authorId: 'human-1',
      authorIsBot: false,
      content: 'What about the UB buffer limit?',
      isReply: true,
      repliedToMessageId: 'm-9',
      repliedToAuthorId: 'my-bot-9',
      botUserId: 'my-bot-9',
    });
    assert.equal(humanImplicitReply.action, 'deliver');

    // Outbound check on child thread inherits parent-chan-1
    const state = loadAccessState(paths.accessPath);
    const outCheck = isOutboundTargetAllowed(state, {
      id: 'thread-555',
      guildId: 'guild-1',
      type: 11,
      parentId: 'parent-chan-1',
    });
    assert.equal(outCheck.allowed, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('queue & envelope: durable FIFO deduplication, XML escaping, and reply receipts', () => {
  const { dir, paths } = makeTempState();
  try {
    const item = {
      source: 'guild',
      channelId: 'thread-1',
      channelName: 'ascendc-fa',
      threadParentId: 'chan-1',
      guildId: 'guild-1',
      messageId: 'msg-101',
      authorId: 'u-1',
      authorName: 'ClaudeBlue',
      authorIsBot: true,
      createdAt: '2026-11-23T19:00:00.000Z',
      content: 'Check </channel> injection & <script>',
      attachments: [{ id: 'a1', name: 'trace.json', size: 4096, contentType: 'application/json' }],
    };

    const e1 = enqueueInbound(paths, item);
    assert.equal(e1.enqueued, true);
    const e2 = enqueueInbound(paths, item);
    assert.equal(e2.enqueued, false);
    assert.equal(e2.duplicate, true);

    const pending = peekPendingQueue(paths);
    assert.equal(pending.length, 1);

    const xml = formatDiscordEnvelope(pending[0]);
    assert.match(xml, /<discord-reply-reminder source_type="thread" chat_id="thread-1" reply_to="msg-101">/);
    assert.match(xml, /chat_id="thread-1"/);
    assert.match(xml, /reply="required"/);
    assert.match(xml, /is_bot="true"/);
    assert.match(xml, /attachment_count="1"/);
    assert.ok(!xml.includes('Check </channel>'), 'must escape embedded </channel> tag');
    assert.ok(xml.includes('Check &lt;/channel> injection &amp; &lt;script>'));

    markDelivered(paths, 'thread-1', 'msg-101', '056d4d74-ec64-49e0-a690-8eadf717a570');
    assert.equal(peekPendingQueue(paths).length, 0);

    // Re-arriving already delivered message is suppressed
    const e3 = enqueueInbound(paths, item);
    assert.equal(e3.enqueued, false);
    assert.equal(e3.duplicate, true);
    assert.equal(readQueueStatus(paths).deliveredWindowCount, 1);

    // Reply receipts
    assert.equal(checkReplyReceipt(paths, 'thread-1', 'msg-101'), null);
    recordReplyReceipt(paths, 'thread-1', 'msg-101', ['out-900']);
    assert.deepEqual(checkReplyReceipt(paths, 'thread-1', 'msg-101').outboundMessageIds, ['out-900']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('session-route: discovers conversationId from simulated /proc fd + hook and invokes agentapi', async () => {
  const { dir, paths } = makeTempState();
  try {
    const fakeProc = path.join(dir, 'proc');
    const fakePid = 42424;
    const convA = '11111111-2222-3333-4444-555555555555';
    const convB = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    fs.mkdirSync(path.join(fakeProc, String(fakePid), 'fd'), { recursive: true });
    fs.writeFileSync(
      path.join(fakeProc, String(fakePid), 'stat'),
      `${fakePid} (agy) S 1 ${fakePid} ${fakePid} 0 -1 4194304 0 0 0 0 10 5 0 0 20 0 1 0 987654321 0 0\n`,
    );
    fs.writeFileSync(path.join(fakeProc, String(fakePid), 'cmdline'), 'agy\0--continue\0');
    const lockTarget = path.join(dir, 'presence', `${convB}.lock`);
    fs.mkdirSync(path.dirname(lockTarget), { recursive: true });
    fs.writeFileSync(lockTarget, '');
    fs.symlinkSync(lockTarget, path.join(fakeProc, String(fakePid), 'fd', '28'));

    assert.equal(discoverConversationFromProcFd(fakePid, fakeProc), convB);

    recordHookSessionBind(
      paths,
      { conversationId: convA, hookEventName: 'SessionStart' },
      {
        ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:49999',
        ANTIGRAVITY_CSRF_TOKEN: 'csrf-secret',
        ANTIGRAVITY_AGENTAPI_EXE: '/usr/local/bin/agy',
      },
      fakeProc,
    );

    const cfg = loadConfig({
      HOME: dir,
      DISCORD_STATE_DIR: paths.stateDir,
      ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:49999',
      ANTIGRAVITY_CSRF_TOKEN: 'csrf-secret',
      ANTIGRAVITY_AGENTAPI_EXE: '/usr/local/bin/agy',
    });

    // Live presence fd (convB) takes precedence over older hook convA for the same agy process
    const route = resolveSessionRoute(
      cfg,
      { pid: fakePid, startTicks: '987654321' },
      fakeProc,
    );
    assert.equal(route.ready, true);
    assert.equal(route.conversationId, convB);
    assert.equal(route.conversationSource, 'proc_presence_fd');

    let capturedCall = null;
    const res = await deliverToAgySession(route, 'Discord: blue', '<channel>hi</channel>', {
      execFile: (bin, args, opts, cb) => {
        capturedCall = { bin, args, env: opts.env };
        cb(
          null,
          JSON.stringify({
            response: { sendMessage: { recipientId: convB, content: '<channel>hi</channel>' } },
          }),
          '',
        );
      },
    });
    assert.equal(res.recipientId, convB);
    assert.deepEqual(capturedCall.args.slice(0, 4), [
      'agentapi',
      'send-message',
      '--title=Discord: blue',
      convB,
    ]);
    assert.equal(capturedCall.env.ANTIGRAVITY_CSRF_TOKEN, 'csrf-secret');

    // Receiver lock acquire + release
    const l1 = acquireReceiverLock(paths, { pid: fakePid, startTicks: '987654321' });
    assert.equal(l1.acquired, true);
    releaseReceiverLock(paths);
    assert.equal(fs.existsSync(paths.receiverLockPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gateway + MCP: end-to-end inbound multi-thread delivery, chunking, exfil guard, and JSON-RPC tools', async () => {
  const { dir, paths } = makeTempState();
  try {
    saveEnvKey(paths.envFile, 'DISCORD_BOT_TOKEN', 'fake-token');
    saveAccessState(paths.accessPath, {
      dmPolicy: 'allowlist',
      allowBots: true,
      allowFrom: ['human-1', 'bot-peer'],
      groups: {
        'chan-main': { requireMention: true, allowBots: true, allowFrom: [] },
      },
    });

    const delivered = [];
    const sentMessages = [];

    class FakeClient {
      constructor() {
        this.handlers = {};
        this.user = { id: 'my-bot-id', tag: 'AgyBot#0001' };
        this.channels = {
          fetch: async (id) => ({
            id,
            name: id === 'thread-99' ? 'kernel-opt-thread' : 'main',
            guildId: id === 'dm-1' ? null : 'guild-1',
            type: id === 'dm-1' ? 1 : id === 'thread-99' ? 11 : 0,
            parentId: id === 'thread-99' ? 'chan-main' : null,
            recipientId: id === 'dm-1' ? 'human-1' : null,
            isTextBased: () => true,
            isThread: () => id === 'thread-99',
            send: async (payload) => {
              const outId = `out-${sentMessages.length + 1}`;
              sentMessages.push({ channelId: id, outId, payload });
              return { id: outId };
            },
            messages: {
              fetch: async () =>
                new Map([
                  [
                    'm-prev',
                    {
                      id: 'm-prev',
                      content: 'previous msg',
                      author: { id: 'bot-peer', username: 'ClaudeBlue', bot: true },
                      createdAt: new Date('2026-11-23T19:00:00Z'),
                      attachments: new Map(),
                    },
                  ],
                ]),
            },
          }),
        };
      }
      on(ev, fn) {
        this.handlers[ev] = fn;
      }
      async login() {
        if (this.handlers.ready) this.handlers.ready(this);
        return 'ok';
      }
      async destroy() {}
    }

    const fakeDiscord = {
      Client: FakeClient,
      Events: { ClientReady: 'ready', MessageCreate: 'messageCreate' },
      GatewayIntentBits: { DirectMessages: 1, Guilds: 2, GuildMessages: 4, MessageContent: 8 },
      Partials: { Channel: 1 },
    };

    const cfg = loadConfig({ HOME: dir, DISCORD_STATE_DIR: paths.stateDir });
    const service = createDiscordService({
      initialConfig: cfg,
      logger: () => {},
      deps: {
        ownerAgy: null,
        discord: fakeDiscord,
        resolveSessionRoute: () => ({
          ready: true,
          conversationId: '056d4d74-ec64-49e0-a690-8eadf717a570',
          conversationSource: 'proc_presence_fd',
        }),
        deliverToAgySession: async (route, title, content) => {
          delivered.push({ route, title, content });
          return { recipientId: route.conversationId };
        },
      },
    });

    await service.tryConnectGateway();

    // Inbound 1: Thread message from peer bot mentioning us
    await service.handleInboundMessage({
      id: 'in-thread-1',
      channelId: 'thread-99',
      guildId: 'guild-1',
      content: '<@my-bot-id> can you benchmark the 950DT matmul?',
      author: { id: 'bot-peer', username: 'ClaudeBlue', bot: true },
      channel: {
        type: 11,
        name: 'kernel-opt-thread',
        parentId: 'chan-main',
        isThread: () => true,
        sendTyping: async () => {},
      },
      mentions: {
        everyone: false,
        users: new Map([['my-bot-id', true]]),
        roles: new Map(),
      },
      attachments: new Map(),
      createdAt: new Date('2026-11-23T19:05:00Z'),
      react: async () => {},
    });

    // Inbound 2: Direct Message from allowlisted human -> SAME session!
    await service.handleInboundMessage({
      id: 'in-dm-2',
      channelId: 'dm-1',
      guildId: null,
      content: 'Please prioritize the flash-attention thread first.',
      author: { id: 'human-1', username: 'owner', bot: false },
      channel: {
        type: 1,
        name: 'DM',
        isThread: () => false,
        sendTyping: async () => {},
      },
      mentions: { everyone: false, users: new Map(), roles: new Map() },
      attachments: new Map(),
      createdAt: new Date('2026-11-23T19:05:05Z'),
      react: async () => {},
    });

    assert.equal(delivered.length, 2, 'Both thread message and DM must route to the same AGY session');
    assert.match(delivered[0].content, /chat_id="thread-99".*is_bot="true"/);
    assert.match(delivered[1].content, /chat_id="dm-1".*is_bot="false"/);

    // Outbound reply via MCP JSON-RPC
    const rpcResponses = [];
    await handleJsonRpcMessage(
      service,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'reply',
          arguments: {
            chat_id: 'thread-99',
            reply_to: 'in-thread-1',
            text: 'Running benchmark now!',
          },
        },
      },
      (msg) => rpcResponses.push(msg),
    );

    assert.equal(rpcResponses[0].result.content[0].text, 'sent (id: out-1)');
    assert.equal(sentMessages[0].channelId, 'thread-99');
    assert.equal(sentMessages[0].payload.reply.messageReference, 'in-thread-1');

    // Exfiltration guard: must block sending state .env
    assert.throws(() => assertSendableFile(paths.envFile, paths.stateDir), /Refusing to upload/);

    // Chunking check
    const chunks = chunkText(`${'a'.repeat(1200)}\n\n${'b'.repeat(1200)}`, 2000, 'newline');
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].length, 1200);
    assert.equal(chunks[1].length, 1200);

    await service.shutdown();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cli PreInvocation hook: extracts unseen Discord <channel> blocks into TUI user_markdown once', () => {
  const { dir, paths } = makeTempState();
  try {
    const transcript = path.join(dir, 'transcript.jsonl');
    const step = {
      step_index: 10,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      content:
        '<SYSTEM_MESSAGE>\n<channel source="discord" chat_id="1500001" channel_name="ops" message_id="m-777" user="alice" is_bot="false">\n&lt;@999000111> hello TUI!\n</channel>\n</SYSTEM_MESSAGE>',
    };
    fs.writeFileSync(transcript, `${JSON.stringify(step)}\n`);

    const b1 = extractNewDiscordBanners(transcript, paths.tuiEchoStatePath);
    assert.equal(b1.length, 1);
    assert.match(b1[0], /\[Discord · #ops\].*@alice/);
    assert.match(b1[0], /> <@999000111> hello TUI!/);

    // Second invocation does not re-emit already echoed message_id
    const b2 = extractNewDiscordBanners(transcript, paths.tuiEchoStatePath);
    assert.equal(b2.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('codex-hardened safeguards: ANSI escape sanitization, stale backlog archival, duplicate reply suppression, and generation lock check', async () => {
  const { dir, paths } = makeTempState();
  try {
    // 1. ANSI control sequence escaping
    assert.equal(sanitizeControlChars('hello \x1b[31mred\x00world\nnext'), 'hello \\x1b[31mred\\x00world\nnext');

    // 2. Stale backlog (>6h) archived automatically without replaying
    enqueueInbound(paths, {
      source: 'dm',
      channelId: 'dm-old',
      messageId: 'm-stale',
      authorId: 'u-1',
      content: 'very old message',
    });
    const farFuture = Date.now() + 7 * 60 * 60 * 1000;
    const ready = peekPendingQueue(paths, { now: farFuture });
    assert.equal(ready.length, 0);
    assert.equal(readQueueStatus(paths).archivedCount, 1);

    // 3. Receiver lock generation check detects stolen/rotated generation
    const lock = acquireReceiverLock(paths, null);
    assert.equal(lock.acquired, true);
    assert.equal(isCurrentReceiverLock(paths, lock.holder), true);
    assert.equal(
      isCurrentReceiverLock(paths, { ...lock.holder, generation: 'different-gen' }),
      false,
    );
    releaseReceiverLock(paths, lock.holder);

    // 4. Duplicate reply suppression unless followup=true
    saveEnvKey(paths.envFile, 'DISCORD_BOT_TOKEN', 'fake-token');
    saveAccessState(paths.accessPath, {
      dmPolicy: 'allowlist',
      allowBots: true,
      allowFrom: ['human-1'],
      groups: { 'chan-1': { requireMention: true, allowBots: true, allowFrom: [] } },
    });

    let sendCount = 0;
    class MinimalClient {
      constructor() {
        this.user = { id: 'bot-1', tag: 'Bot#1' };
        this.channels = {
          fetch: async (id) => ({
            id,
            name: 'chan-1',
            guildId: 'g-1',
            type: 0,
            isTextBased: () => true,
            isThread: () => false,
            send: async () => ({ id: `sent-${++sendCount}` }),
          }),
        };
      }
      on() {}
      async login() {
        return 'ok';
      }
      async destroy() {}
    }

    const svc = createDiscordService({
      initialConfig: loadConfig({ HOME: dir, DISCORD_STATE_DIR: paths.stateDir }),
      logger: () => {},
      deps: {
        ownerAgy: null,
        discord: {
          Client: MinimalClient,
          Events: { ClientReady: 'ready', MessageCreate: 'messageCreate' },
          GatewayIntentBits: { DirectMessages: 1, Guilds: 2, GuildMessages: 4, MessageContent: 8 },
          Partials: { Channel: 1 },
        },
        resolveSessionRoute: () => ({ ready: true, conversationId: '056d4d74-ec64-49e0-a690-8eadf717a570' }),
      },
    });
    await svc.tryConnectGateway();

    const r1 = await svc.sendReply({ chatId: 'chan-1', replyTo: 'src-55', text: 'first answer' });
    assert.equal(r1.duplicateSuppressed, false);
    assert.equal(sendCount, 1);

    const r2 = await svc.sendReply({ chatId: 'chan-1', replyTo: 'src-55', text: 'accidental duplicate' });
    assert.equal(r2.duplicateSuppressed, true);
    assert.equal(sendCount, 1, 'second reply without followup=true must not hit Discord API');

    const r3 = await svc.sendReply({
      chatId: 'chan-1',
      replyTo: 'src-55',
      text: 'explicit followup',
      followup: true,
    });
    assert.equal(r3.duplicateSuppressed, false);
    assert.equal(sendCount, 2);

    await svc.shutdown();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
