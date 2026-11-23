# Architecture & Operations Guide

`agy-discord-channel` brings the **1 local console session = 1 Discord bot** model from Claude Code's Discord channel plugin and [`zhshgmail/codex-discord-channel`](https://github.com/zhshgmail/codex-discord-channel) natively to **Google Antigravity CLI (`agy`)**.

---

## 1. End-to-End Message Flow

```text
Discord Gateway (DM / Guild Channel / Thread)
  │
  ▼
access.js gate (pairing | allowlist | thread parent inheritance | allowBots + bot reply loop guard)
  │
  ▼
Durable state-dir FIFO (`~/.gemini/channels/discord/<instance>/pending-delivery.json`)
  │
  ▼
session-route.js (`/proc/<owner_agy_pid>/fd` -> `presence/<conversationId>.lock` + LS credentials)
  │
  ▼
`agy agentapi send-message` (`MESSAGE_PRIORITY_HIGH` reactive wakeup into the exact visible `agy` session)
  │
  ▼
`<discord-reply-reminder>` + `<channel source="discord" ... reply="required">`
  │
  ▼
MCP `reply` tool -> Durable per-source receipt (`reply-receipts/`) -> Discord REST API
```

---

## 2. Production Lessons Adopted from `codex-discord-channel`

1. **`DISCORD_STATE_DIR` is the sole durable bot identity:**
   * Token (`.env`), access policy (`access.json`), inbound FIFO (`pending-delivery.json`), reply receipts (`reply-receipts/`), and receiver lock (`receiver.lock.json`) live strictly under `~/.gemini/channels/discord/<instance>`.
   * Antigravity `conversationId` and Language Server ports are transient session coordinates resolved dynamically from `/proc/<owner_agy_pid>/fd` (`presence/<conversationId>.lock`) and `SessionStart`/`PreInvocation` hooks—switching conversations via `/new` or `/resume` inside the same `agy` terminal seamlessly routes Discord messages to the active conversation without reconfiguring the bot.
2. **Generation-fenced single-receiver lock (`receiver.lock.json`):**
   * Verified by `{ mcpPid, mcpStartTicks, generation }` using Linux `/proc/<pid>/stat` start ticks so PID reuse cannot impersonate a live gateway and stale dead locks are automatically reclaimed on startup.
   * Opening a second `agy` terminal without setting `DISCORD_INSTANCE` will neither double-connect the Discord bot nor hijack inbound messages away from the owning `agy` console.
3. **Metadata-bound `<discord-reply-reminder>` + Receipt Deduplication:**
   * Every injected message binds `chat_id` and `reply_to` from verified Discord metadata (never from untrusted message text) and enforces per-source reply receipts (`reply-receipts/`) so accidental duplicate replies to the same `message_id` are suppressed unless `followup: true` is passed.
4. **Peer Bot Collaboration Without Infinite Loops:**
   * When `allowBots: true` is enabled for multi-agent channels (Claude Code, Codex, Antigravity bots collaborating together), a peer bot replying to one of our messages **must** explicitly `@mention` us (`<@BOT_ID>`, `<@&ROLE_ID>`, or `@everyone`) in the new message body (`guild_bot_reply_mention_required`), preventing endless bot-to-bot receipt ping-pong while still allowing humans to reply naturally without re-typing `@bot`.
5. **Bounded Resources, Safe Text & Stale Backlog Archival:**
   * Tightly bounded `discord.js` caches (`MessageManager: 10`, `ReactionManager: 0`, `PresenceManager: 0`, `UserManager: 48`) with RSS/heap telemetry in `gateway-health.json`.
   * Escapes ANSI terminal control sequences (`\x1b`) and embedded `</channel>` XML tags in untrusted message content, caps `fetch_messages` output at 60 KiB, and archives pre-session backlog items older than 6 hours instead of replaying stale history.

---

## 3. Multi-Instance Operation & Safe Upgrades

### Running Multiple Bots on One Machine

Each bot uses its own Discord Bot Token and isolated state directory via `DISCORD_INSTANCE`:

```bash
# Instance 1 (default -> ~/.gemini/channels/discord/default)
~/.gemini/config/plugins/agy-discord-channel/bin/agy-discord configure "<TOKEN_1>" --bot-id "<BOT_ID_1>"
agy --dangerously-skip-permissions

# Instance 2 (agy02 -> ~/.gemini/channels/discord/agy02)
DISCORD_INSTANCE=agy02 ~/.gemini/config/plugins/agy-discord-channel/bin/agy-discord configure "<TOKEN_2>" --bot-id "<BOT_ID_2>"
DISCORD_INSTANCE=agy02 agy --dangerously-skip-permissions
```

### Safe Upgrade Procedure (One Instance at a Time)

1. Finish any active turn in the target `agy` console and exit that `agy` session normally (`/exit` or `Ctrl+D Ctrl+D`) so its MCP gateway releases `receiver.lock.json` cleanly. Never run broad `pkill node` or `killall` on a shared multi-agent machine.
2. Pull/build or install the updated plugin release:
   ```bash
   agy plugin install https://github.com/zhshgmail/agy-discord-channel/tree/main/plugins/agy-discord-channel
   ```
3. Relaunch `agy --continue --dangerously-skip-permissions` (with `DISCORD_INSTANCE=<name>` if non-default) and verify `discord_status` reports `gateway.connected: true` and `sessionRoute.ready: true`.
