# AGY Discord Channel (`agy-discord-channel`)

Session-bound Discord bot plugin for **Google Antigravity CLI (`agy`)**, bringing the **1 local console session = 1 Discord bot** workflow from Claude Code's Discord plugin and [`zhshgmail/codex-discord-channel`](https://github.com/zhshgmail/codex-discord-channel) natively to Antigravity.

## Key Features

* **1 Local `agy` Session = 1 Discord Bot:** Your running `agy` terminal console owns a single Discord bot connection (`receiver.lock.json`, generation + `/proc/<pid>/stat` start-time fenced). Exiting `agy` disconnects the bot cleanly.
* **Multi-Thread, Multi-Channel & DM Collaboration:** Invite the bot into multiple Discord channels, threads, and human DMs—all admitted messages route asynchronously into **the exact same active `agy` session** via Antigravity's native `agentapi` messaging bus (`MESSAGE_PRIORITY_HIGH` reactive wakeup), while your local `agy` console stays interactive at all times.
* **Metadata-Bound `<discord-reply-reminder>` & Receipt Protection:** Every injected message wraps `<channel source="discord" ... reply="required">` with exact `chat_id` + `reply_to` routing instructions and durable per-source reply receipts (`reply-receipts/`), preventing accidental duplicate replies unless `followup: true` is passed.
* **Peer Agent Collaboration (`allowBots` + Loop Guard):** Works seamlessly alongside Claude Code and Codex bots in shared Discord channels/threads (`<@bot_id>`, `<@&role_id>`, `@everyone`), while enforcing `guild_bot_reply_mention_required` so peer bots never enter infinite unmentioned reply loops.
* **Self-Contained Runtime Bundle:** Ships pre-bundled `runtime/mcp-server.cjs` and `runtime/cli.cjs` (Node >= 22.15, zero `npm install` needed at plugin install time), with HTTP/HTTPS proxy support (`DISCORD_PROXY_URL` / `HTTPS_PROXY`), ANSI control-char sanitization, 60 KiB history output caps, and stale backlog archival.

See [docs/architecture-and-operations.md](docs/architecture-and-operations.md) for architecture details and multi-instance operational runbooks.

---

## Installation

### Install Directly from GitHub

```bash
agy plugin install https://github.com/zhshgmail/agy-discord-channel/tree/main/plugins/agy-discord-channel
agy plugin enable agy-discord-channel
```

### Or Install from a Local Clone (Development)

```bash
git clone https://github.com/zhshgmail/agy-discord-channel.git
cd agy-discord-channel
agy plugin install ./plugins/agy-discord-channel
agy plugin enable agy-discord-channel
```

---

## Quick Setup

### 1. Create & Configure Your Discord Bot

1. In the [Discord Developer Portal](https://discord.com/developers/applications), create an Application → **Bot** → enable **Message Content Intent** under *Privileged Gateway Intents*.
2. Invite the bot (`bot` scope: *View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Read Message History, Attach Files, Add Reactions*) to your server and grant it access to any private channels it should join.
3. Save the token locally (`0600` permissions in `~/.gemini/channels/discord/default/.env`—never committed):

```bash
~/.gemini/config/plugins/agy-discord-channel/bin/agy-discord configure "<DISCORD_BOT_TOKEN>" \
  --bot-id "<DISCORD_BOT_USER_ID>"
```

*(Add `--proxy "<PROXY_URL>"` if outbound Discord traffic requires an HTTP/HTTPS proxy. If `agy` is already running, the plugin hot-loads `.env` within ~3 seconds.)*

### 2. Configure Access Policy (or Import Existing Claude/Codex Team Access)

**Option A — Import an existing Claude Code or Codex `access.json`:**
```bash
~/.gemini/config/plugins/agy-discord-channel/bin/agy-discord import-access \
  --from ~/.claude/channels/discord/access.json \
  --bot-id "<DISCORD_BOT_USER_ID>" \
  --role-id "<OPTIONAL_BOT_ROLE_ID>"
```

**Option B — Configure via CLI or `/discord-access` skill:**
```bash
# Pair via DM (DM the bot first to receive a 6-char pairing code):
~/.gemini/config/plugins/agy-discord-channel/bin/agy-discord access pair <code>

# Enable a guild channel (all child threads inherit access automatically):
~/.gemini/config/plugins/agy-discord-channel/bin/agy-discord access group add <CHANNEL_ID> --allow-bots

# Lock DM policy once all snowflakes are allowlisted:
~/.gemini/config/plugins/agy-discord-channel/bin/agy-discord access policy allowlist
```

### 3. Launch (Single or Multiple Bot Instances)

```bash
# Default instance (~/.gemini/channels/discord/default)
agy --dangerously-skip-permissions

# Second isolated bot instance on the same machine (~/.gemini/channels/discord/agy02)
DISCORD_INSTANCE=agy02 agy --dangerously-skip-permissions
```

> **Note:** On the first turn of a session, if `discord_status` reports `sessionRoute.reason === "waiting_for_ls_credentials"`, run `~/.gemini/config/plugins/agy-discord-channel/bin/agy-discord bind-hook </dev/null` once inside `agy` (also documented in the bundled `AGENTS.md` rule) to bind the session's Language Server credentials.

---

## MCP Tools Exposed to Antigravity

| Tool | Description |
| :--- | :--- |
| `reply` | Send or reply to any allowlisted `chat_id` (DM, guild channel, or thread), with `reply_to` threading, receipt deduplication (`followup: true` for intentional follow-ups), `files` attachments, and 2000-char smart chunking. |
| `fetch_messages` | Read bounded recent history (defaults to last inbound channel if `channel` omitted; up to 100 messages, 60 KiB output cap, `before` cursor pagination). |
| `react` | Add Unicode or `<:name:id>` emoji reactions to messages. |
| `edit_message` | Edit a message previously sent by this bot. |
| `download_attachment` | Download attachments from a Discord message into `~/.gemini/channels/discord/<instance>/inbox/`. |
| `create_thread` | Start a new Discord discussion thread in an allowlisted channel or anchored to `message_id`. |
| `discord_status` | Inspect live Discord gateway connection, memory/cache telemetry, bound `conversationId`, queue depth, and access summary. |

---

## Development & Verification Gates

```bash
npm ci
npm run build
npm run check
agy plugin validate --strict ./plugins/agy-discord-channel
```

## License

MIT — see [LICENSE](LICENSE) and [plugins/agy-discord-channel/THIRD_PARTY_NOTICES.txt](plugins/agy-discord-channel/THIRD_PARTY_NOTICES.txt).
