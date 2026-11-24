# AGY Discord Channel (`agy-discord-channel`)

**English** | [简体中文](README.zh-CN.md) | [AI Agent Guide (`AGENT_GUIDE.md`)](AGENT_GUIDE.md) | [Architecture & Operations](docs/architecture-and-operations.md)

[![Version](https://img.shields.io/badge/version-0.2.0-blue.svg)](package.json)
[![Node](https://img.shields.io/badge/node-%3E%3D22.15.0-brightgreen.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)

Session-bound Discord bot channel plugin for **Google Antigravity CLI (`agy`)**, bringing the **1 local console session = 1 Discord bot** workflow from Claude Code's Discord plugin and [`zhshgmail/codex-discord-channel`](https://github.com/zhshgmail/codex-discord-channel) natively to Antigravity.

---

## Why `agy-discord-channel`?

* **1 Local `agy` Session = 1 Discord Bot:** Your running `agy` terminal console owns a single Discord bot connection (`receiver.lock.json`, generation + `/proc/<pid>/stat` start-time fenced). Launching a duplicate console for the same bot instance refuses cleanly instead of causing split-brain message theft, and exiting `agy` disconnects the bot automatically.
* **Multi-Thread, Multi-Channel & DM Collaboration:** Invite the bot into multiple Discord channels, discussion threads, and human DMs—all admitted messages route asynchronously into **the exact same active `agy` session** via Antigravity's native `agentapi` messaging bus (`MESSAGE_PRIORITY_HIGH` reactive wakeup), while your local `agy` console stays interactive at all times.
* **Reliable Attachment Upload & Download (`v0.2.0`):**
  * **Outbound (`reply` with `files`):** Uses Discord's v10 2-step **Cloud Attachments** protocol (`POST /channels/{id}/attachments` → pre-signed `PUT` with automatic retry → pure-JSON message creation) with seamless fallback to buffered multipart upload—eliminating `AbortError` stalls over high-RTT or NAT links. Supports up to 10 files (25 MB each), with or without accompanying text.
  * **Inbound (`download_attachment`):** Downloads message attachments with proxy-aware retry, 25 MB size enforcement, safe original-filename preservation (`.md`, `.tar.xz`, extensionless files), atomic `0600` disk writes, and SHA-256 verification.
* **Multi-Instance Fleet Launcher (`agy-discord-instance`):** Run multiple isolated Discord bots on the same host (`default`, `bot02`, `bot03`, ...), each with its own `~/.gemini/channels/discord/<instance>` state directory, lock check, environment isolation, terminal raw-mode restoration, and automatic startup LS credential bootstrap.
* **Peer Agent Collaboration (`allowBots` + Anti-Loop Guard):** Collaborate safely with Claude Code and Codex bots in shared Discord channels/threads (`<@bot_id>`, `<@&role_id>`, `@everyone`), while enforcing `guild_bot_reply_mention_required` (including ignoring Discord's implicit `repliedUser` ping on quote-replies unless `<@bot_id>` appears in message text) so bots never enter infinite ack loops.
* **Zero-Install Self-Contained Runtime:** Ships pre-bundled `runtime/mcp-server.cjs` and `runtime/cli.cjs` (Node >= 22.15, no `npm install` needed on target hosts), with HTTP/HTTPS proxy support (`DISCORD_PROXY_URL` / `HTTPS_PROXY`), TUI inline message banners, 60 KiB history caps, ANSI control-char sanitization, and durable reply-receipt deduplication.

---

## Quick Start

> **Setting this up with an AI agent?** Hand [AGENT_GUIDE.md](AGENT_GUIDE.md) directly to your Antigravity / Claude / Codex agent for autonomous installation, verification, and multi-agent operating rules.

### 1. Install the Plugin

**Option A — Install directly from GitHub:**
```bash
agy plugin install https://github.com/zhshgmail/agy-discord-channel/tree/main/plugins/agy-discord-channel
agy plugin enable agy-discord-channel
```

**Option B — Install from a local clone:**
```bash
git clone https://github.com/zhshgmail/agy-discord-channel.git
cd agy-discord-channel
agy plugin install ./plugins/agy-discord-channel
agy plugin enable agy-discord-channel
```

*(Manual copy alternative: copy `plugins/agy-discord-channel` to `~/.gemini/config/plugins/agy-discord-channel`.)*

### 2. Create Your Discord Bot & Save Credentials

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application** → **Bot**.
2. Enable **Message Content Intent** under *Privileged Gateway Intents*.
3. Invite the bot (`bot` scope) to your Discord server with permissions:
   * *View Channels*, *Send Messages*, *Send Messages in Threads*, *Create Public Threads*, *Read Message History*, *Attach Files*, *Add Reactions*.
4. Save the bot token locally (stored with `0600` permissions in `~/.gemini/channels/discord/default/.env`—never committed to Git):

```bash
~/.gemini/config/plugins/agy-discord-channel/bin/agy-discord configure "<DISCORD_BOT_TOKEN>" \
  --bot-id "<DISCORD_BOT_USER_ID>"
```

If outbound Discord traffic requires an HTTP/HTTPS proxy, add `--proxy "http://proxy.example.com:8080"`. Running sessions hot-detect `.env` updates within ~3 seconds.

### 3. Configure Access Policy

**Option A — Import an existing Claude Code or Codex `access.json`:**
```bash
~/.gemini/config/plugins/agy-discord-channel/bin/agy-discord import-access \
  --from /path/to/existing/access.json \
  --bot-id "<DISCORD_BOT_USER_ID>" \
  --role-id "<OPTIONAL_TEAM_BOT_ROLE_ID>"
```

**Option B — Pair via DM & allowlist guild channels:**
```bash
# 1. Send a DM to your bot on Discord to receive a 6-character pairing code, then approve it:
~/.gemini/config/plugins/agy-discord-channel/bin/agy-discord access pair <6-char-code>

# 2. Enable a guild channel (all threads under this channel inherit access automatically):
~/.gemini/config/plugins/agy-discord-channel/bin/agy-discord access group add <CHANNEL_ID> --allow-bots

# 3. Optional: lock DM policy to explicit allowlist once paired:
~/.gemini/config/plugins/agy-discord-channel/bin/agy-discord access policy allowlist
```

### 4. Launch Antigravity (`agy-discord-instance` Recommended)

Use the bundled `agy-discord-instance` launcher to pre-check instance locks, isolate environment variables, and automatically bind Antigravity's Language Server credentials on startup:

```bash
# Launch the default bot instance in your workspace directory:
~/.gemini/config/plugins/agy-discord-channel/bin/agy-discord-instance default -C /path/to/workspace

# Launch a second isolated bot instance ("bot02") on the same machine:
DISCORD_INSTANCE=bot02 ~/.gemini/config/plugins/agy-discord-channel/bin/agy-discord configure "<SECOND_BOT_TOKEN>" --bot-id "<SECOND_BOT_ID>"
~/.gemini/config/plugins/agy-discord-channel/bin/agy-discord-instance bot02 -C /path/to/second-workspace
```

You can also add a shell alias to `~/.bashrc`:
```bash
alias agy-bot='~/.gemini/config/plugins/agy-discord-channel/bin/agy-discord-instance default'
```

> **Manual Launch Note:** If you launch plain `agy --dangerously-skip-permissions` without `agy-discord-instance` and `discord_status` reports `sessionRoute.reason === "waiting_for_ls_credentials"`, have the agent run `~/.gemini/config/plugins/agy-discord-channel/bin/agy-discord bind-hook </dev/null` once via `run_command`.

---

## Uploading & Downloading Attachments

### Uploading Files to Discord (`reply` with `files`)

Pass absolute file paths in `files` when calling the `reply` MCP tool (up to 10 files per message, max 25 MB per file). Accompanying `text` is optional when `files` is non-empty:

```json
{
  "chat_id": "123456789012345678",
  "reply_to": "987654321098765432",
  "text": "Benchmark summary and full report attached.",
  "files": [
    "/abs/path/to/BENCHMARK_REPORT.md",
    "/abs/path/to/profile_trace.json"
  ]
}
```

* **Security Guard:** Internal channel state files (`~/.gemini/channels/discord/<instance>/.env`, `access.json`, queue files) are blocked from outbound upload automatically (`assertSendableFile`).

### Downloading Attachments from Discord (`download_attachment`)

Inbound messages with attachments include `attachment_count` and `attachments="name (type, size)"` metadata in their `<channel>` envelope, and `fetch_messages` lists `+Natt[id:filename (KB)]`. To download attachments locally:

```json
{
  "chat_id": "123456789012345678",
  "message_id": "987654321098765432"
}
```

Optional parameters:
* `save_dir`: Save into a specific workspace directory instead of `~/.gemini/channels/discord/<instance>/inbox/`.
* `attachment_id` or `filename`: Download a single matching attachment from a multi-attachment message.

Each downloaded file is written atomically (`0600`) with its sanitized original filename, exact byte count, MIME type, and SHA-256 prefix.

---

## MCP Tools Reference

| Tool | Key Arguments | Description |
| :--- | :--- | :--- |
| `reply` | `chat_id`, `text?`, `reply_to?`, `files?`, `followup?` | Send a message and/or file attachments to an allowlisted DM, channel, or thread. Auto-splits text > 2000 chars and suppresses accidental duplicate replies to the same `reply_to` unless `followup: true` is set. |
| `fetch_messages` | `channel`, `limit?`, `before?` | Read recent message history (oldest-first, up to 100 messages, 60 KiB cap, with user IDs, `[bot]` badges, `reply_to` refs, and attachment IDs/names). |
| `download_attachment` | `chat_id`, `message_id`, `save_dir?`, `attachment_id?`, `filename?` | Download attachments from a message with automatic retry, 25 MB guard, filename preservation, and SHA-256 digest output. |
| `react` | `chat_id`, `message_id`, `emoji` | Add a Unicode (`👀`, `✅`) or custom (`<:name:id>`) reaction to a message. |
| `edit_message` | `chat_id`, `message_id`, `text` | Edit a message previously sent by this bot (e.g., live progress updates). |
| `create_thread` | `chat_id`, `name`, `message_id?` | Create a new Discord discussion thread in an allowlisted channel or anchored to `message_id`. |
| `discord_status` | *(none)* | Inspect gateway connection health, memory/cache usage, `sessionRoute` binding, queue depth, and access summary. |

---

## CLI Reference (`bin/agy-discord`)

```bash
agy-discord status                                         # Full bot, session, queue, and access report
agy-discord configure "<TOKEN>" [--bot-id ID] [--proxy URL]# Save bot token & optional proxy (mode 0600)
agy-discord configure clear                                # Clear saved bot token
agy-discord access status                                  # Show current access.json policy
agy-discord access pair <6-char-code>                      # Approve pending DM pairing code
agy-discord access deny <6-char-code>                      # Reject pending DM pairing code
agy-discord access allow <user_or_bot_id>                  # Add snowflake to allowFrom
agy-discord access remove <user_or_bot_id>                 # Remove snowflake from allowFrom
agy-discord access policy <pairing|allowlist|open|disabled># Set DM admission policy
agy-discord access allow-bots <true|false>                 # Toggle peer-bot collaboration
agy-discord access group add <channel_id> [--no-mention] [--allow-bots] [--allow id1,id2]
agy-discord access group rm <channel_id>                   # Disable a guild channel
agy-discord access set <ackReaction|replyToMode|textChunkLimit|chunkMode|mentionPatterns> <value>
agy-discord import-access --from <access.json> [--bot-id ID] [--role-id ID]
```

### Optional Environment Variables

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `DISCORD_INSTANCE` | `default` | Selects `~/.gemini/channels/discord/<instance>` state directory. |
| `DISCORD_STATE_DIR` | *(derived)* | Explicit state directory override. |
| `DISCORD_PROXY_URL` | *(unset)* | HTTP/HTTPS proxy URL (falls back to `HTTPS_PROXY` / `HTTP_PROXY`). |
| `DISCORD_REST_TIMEOUT_MS` | `45000` | Per-attempt Discord REST API timeout in milliseconds. |
| `DISCORD_REST_RETRIES` | `2` | Discord REST retry count on transient timeout/5xx errors. |
| `DISCORD_TRANSFER_TIMEOUT_MS` | `60000` | Per-attempt timeout (ms) for attachment `PUT` uploads and CDN `GET` downloads. |
| `DISCORD_UPLOAD_MODE` | `auto` | `auto` (2-step Cloud Attachments with multipart fallback), `cloud`, or `multipart`. |

---

## Updating & Hot-Reload Behavior

* **`.env` & `access.json` changes:** Picked up **live** without restarting `agy`.
* **Hook / CLI updates (`runtime/cli.cjs`):** Picked up on the very next CLI command or `PreInvocation` hook execution.
* **MCP server / gateway updates (`runtime/mcp-server.cjs`):** Because `agy` runs `./bin/agy-discord-mcp` as a persistent long-lived child process for the duration of the session, updating `runtime/mcp-server.cjs` on disk **requires restarting the `agy` session (or restarting its MCP server)** for the running gateway/MCP process to load the new bundle into memory.

---

## Development & Verification Gates

```bash
npm ci
npm run build
npm run check
```

`npm run check` validates shell syntax (`sh -n` / `bash -n`), JavaScript syntax (`node --check`), the full unit & integration test suite (`node --test`), bundle reproducibility (`build-runtime.js --check`), and secret/manifest smoke checks (`scripts/smoke.js`).

## License

MIT — see [LICENSE](LICENSE) and [plugins/agy-discord-channel/THIRD_PARTY_NOTICES.txt](plugins/agy-discord-channel/THIRD_PARTY_NOTICES.txt).
