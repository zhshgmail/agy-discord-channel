# AGY Discord Channel (`agy-discord-channel`)

[English](README.md) | **简体中文** | [AI Agent 安装与协作指南 (`AGENT_GUIDE.md`)](AGENT_GUIDE.md) | [架构与运维手册](docs/architecture-and-operations.md)

[![Version](https://img.shields.io/badge/version-0.2.0-blue.svg)](package.json)
[![Node](https://img.shields.io/badge/node-%3E%3D22.15.0-brightgreen.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)

面向 **Google Antigravity CLI (`agy`)** 的会话绑定式 Discord 机器人通道插件，将 Claude Code Discord 插件与 [`zhshgmail/codex-discord-channel`](https://github.com/zhshgmail/codex-discord-channel) 中成熟的 **“1 个本地终端会话 = 1 个 Discord 机器人”** 多智能体协作体验原生带入 Antigravity。

---

## 核心特性

* **1 个本地 `agy` 会话 = 1 个专属 Discord Bot：** 当前运行的 `agy` 终端通过 `receiver.lock.json`（含 `generation` 与 `/proc/<pid>/stat` 启动时钟戳校验）独占绑定对应的 Discord Bot 实例。重复启动同一实例会安全拦截（避免多会话抢消息），退出 `agy` 后机器人自动优雅下线。
* **私信 (DM)、频道与子讨论串 (Thread) 多路并发汇聚：** 同一个 Bot 可以同时加入多个频道、子 Thread 并接收人类私信——所有准入消息都会通过 Antigravity 原生 `agentapi` 总线（`MESSAGE_PRIORITY_HIGH` 响应式唤醒）异步推送到**同一个正在运行的 `agy` 会话**，且本地终端交互全程保持流畅。
* **高可靠附件上传与下载 (`v0.2.0`)：**
  * **附件上传（`reply` 的 `files` 参数）：** 默认采用 Discord v10 官方两步式 **Cloud Attachments** 协议（`POST /channels/{id}/attachments` 申请预签名槽位 → 带自动重试的直传 `PUT` → 纯 JSON 创建消息），并在异常时自动回退到内存缓冲式 Multipart 上传，彻底解决高延迟/NAT 链路下传统 Multipart 流式上传触发 `This operation was aborted` 的超时问题。单条消息最多支持 10 个附件（单个上限 25 MB），支持纯文件发送（无需附带正文）。
  * **附件下载（`download_attachment` 工具）：** 支持代理感知的自动重试、25 MB 大小双重校验、保留原始安全文件名（完整保留 `.md`、`.tar.xz` 及无后缀文件名如 `config`）、原子化 `0600` 权限落盘，并返回精确字节数与 SHA-256 摘要。
* **多实例启动器 (`agy-discord-instance`)：** 支持在同一台机器上并行运行多个相互隔离的 Discord Bot 实例（如 `default`、`bot02`、`bot03`），自动完成锁冲突检测、环境变量隔离、工作目录切换 (`-C`)、终端 `stty` 状态恢复以及启动时自动绑定 Language Server 凭据。
* **多 Agent 协同与防死循环保护 (`allowBots`)：** 与同一 Discord 服务器中的 Claude Code、Codex 等同伴 Bot 无缝协作（支持 `<@bot_id>`、`<@&role_id>`、`@everyone` 唤醒），内置 `guild_bot_reply_mention_required` 防护（自动忽略 Discord 原生引用回复自带的隐式 `repliedUser` 标记，仅在正文显式包含 `<@bot_id>` 时唤醒），杜绝机器人之间无限礼貌回执死循环。
* **零依赖预打包运行时：** 内置单文件运行时 `runtime/mcp-server.cjs` 与 `runtime/cli.cjs`（仅需 Node >= 22.15，目标机器安装插件时无需执行 `npm install`），原生支持 HTTP/HTTPS 代理、TUI 内联消息横幅展示、历史消息 60 KiB 限流分页、ANSI 控制字符转义及持久化回复去重回执 (`reply-receipts/`)。

---

## 快速上手

> **由 AI Agent 自动安装与运维？** 请直接让您的 Antigravity / Claude / Codex Agent 阅读 [AGENT_GUIDE.md](AGENT_GUIDE.md)，其中包含完整的自举安装、会话绑定自检、附件收发示例与多 Agent 协作防踩坑规范。

### 1. 安装插件

**方式 A — 直接从 GitHub 安装：**
```bash
agy plugin install https://github.com/zhshgmail/agy-discord-channel/tree/main/plugins/agy-discord-channel
agy plugin enable agy-discord-channel
```

**方式 B — 从本地克隆仓库安装：**
```bash
git clone https://github.com/zhshgmail/agy-discord-channel.git
cd agy-discord-channel
agy plugin install ./plugins/agy-discord-channel
agy plugin enable agy-discord-channel
```

*(也可直接将 `plugins/agy-discord-channel` 目录复制到 `~/.gemini/config/plugins/agy-discord-channel`。）*

### 2. 创建 Discord Bot 并配置本地 Token

1. 打开 [Discord Developer Portal](https://discord.com/developers/applications) → **New Application** → **Bot**。
2. 在 *Privileged Gateway Intents* 下开启 **Message Content Intent**。
3. 将 Bot 邀请进您的服务器（勾选 `bot` 作用域及以下权限：*View Channels*、*Send Messages*、*Send Messages in Threads*、*Create Public Threads*、*Read Message History*、*Attach Files*、*Add Reactions*）。
4. 在本地写入 Token（以 `0600` 权限保存在 `~/.gemini/channels/discord/default/.env`，绝不会进入 Git 仓库）：

```bash
~/.gemini/config/plugins/agy-discord-channel/bin/agy-discord configure "<DISCORD_BOT_TOKEN>" \
  --bot-id "<DISCORD_BOT_USER_ID>"
```

若访问 Discord 需要经过 HTTP/HTTPS 代理，请附加 `--proxy "http://proxy.example.com:8080"`。若 `agy` 已在运行，插件会在约 3 秒内自动热加载新配置的 `.env`。

### 3. 配置访问控制策略 (`access.json`)

**方式 A — 一键导入团队现有的 Claude Code / Codex `access.json`：**
```bash
~/.gemini/config/plugins/agy-discord-channel/bin/agy-discord import-access \
  --from /path/to/existing/access.json \
  --bot-id "<DISCORD_BOT_USER_ID>" \
  --role-id "<可选_团队Bot角色ID>"
```

**方式 B — 通过私信配对码与命令行添加白名单：**
```bash
# 1. 在 Discord 给机器人发一条私信，收到 6 位配对码后在本地批准：
~/.gemini/config/plugins/agy-discord-channel/bin/agy-discord access pair <6位配对码>

# 2. 放行指定服务器频道（该频道下的所有子 Thread 会自动继承访问权限）：
~/.gemini/config/plugins/agy-discord-channel/bin/agy-discord access group add <频道ID> --allow-bots

# 3. 可选：配对完成后将私信策略收紧为纯白名单模式：
~/.gemini/config/plugins/agy-discord-channel/bin/agy-discord access policy allowlist
```

### 4. 启动会话（推荐使用 `agy-discord-instance`）

推荐使用内置的 `agy-discord-instance` 启动器，它会自动检查实例锁冲突、清理父 Shell 残留环境变量，并在启动首轮自动完成 Language Server 凭据绑定：

```bash
# 在指定工作目录启动默认实例 (default)：
~/.gemini/config/plugins/agy-discord-channel/bin/agy-discord-instance default -C /path/to/workspace

# 在同一台机器上启动第二个独立 Bot 实例 ("bot02")：
DISCORD_INSTANCE=bot02 ~/.gemini/config/plugins/agy-discord-channel/bin/agy-discord configure "<第二个BOT_TOKEN>" --bot-id "<第二个BOT_ID>"
~/.gemini/config/plugins/agy-discord-channel/bin/agy-discord-instance bot02 -C /path/to/second-workspace
```

建议在 `~/.bashrc` 中配置别名方便日常调用：
```bash
alias agy-bot='~/.gemini/config/plugins/agy-discord-channel/bin/agy-discord-instance default'
```

> **手动启动提示：** 如果直接使用 `agy --dangerously-skip-permissions` 启动而未经过 `agy-discord-instance`，当 `discord_status` 显示 `sessionRoute.reason === "waiting_for_ls_credentials"` 时，只需让 Agent 通过 `run_command` 执行一次 `~/.gemini/config/plugins/agy-discord-channel/bin/agy-discord bind-hook </dev/null` 即可完成实时入站推送绑定。

---

## 附件上传与下载使用说明

### 上传文件到 Discord（`reply` 工具 `files` 参数）

调用 `reply` MCP 工具时传入绝对路径数组 `files`（单次最多 10 个文件，每个不超过 25 MB）。当 `files` 非空时，`text` 可以省略或留空：

```json
{
  "chat_id": "123456789012345678",
  "reply_to": "987654321098765432",
  "text": "附上完整性能分析报告与原始采样日志：",
  "files": [
    "/abs/path/to/BENCHMARK_REPORT.md",
    "/abs/path/to/profile_trace.json"
  ]
}
```

* **安全防泄露保护：** 插件会自动拦截任何试图上传内部状态目录敏感文件（如 `~/.gemini/channels/discord/<instance>/.env`、`access.json`、队列文件）的操作。

### 从 Discord 下载附件（`download_attachment` 工具）

当入站消息带有附件时，`<channel>` 标签会携带 `attachment_count` 与 `attachments="文件名 (类型, 大小)"` 属性（不会未经请求自动下载）；`fetch_messages` 也会显示 `+Natt[附件ID:文件名 (KB)]`。需要读取附件时调用：

```json
{
  "chat_id": "123456789012345678",
  "message_id": "987654321098765432"
}
```

可选参数：
* `save_dir`：指定保存目录（默认保存在 `~/.gemini/channels/discord/<instance>/inbox/`）。
* `attachment_id` 或 `filename`：当一条消息包含多个附件时，仅下载匹配的那一个。

下载完成后工具会返回本地绝对路径、安全文件名、MIME 类型、精确字节数与 SHA-256 校验摘要前缀。

---

## MCP 工具一览

| 工具名称 | 主要参数 | 功能说明 |
| :--- | :--- | :--- |
| `reply` | `chat_id`, `text?`, `reply_to?`, `files?`, `followup?` | 向白名单内的私信、频道或 Thread 发送消息与文件附件；超 2000 字符自动按段落智能切分；默认开启同一 `reply_to` 重复回复防呆保护（确需追发多条时传 `followup: true`）。 |
| `fetch_messages` | `channel`, `limit?`, `before?` | 拉取最近消息历史（按时间正序排列，单次最多 100 条、60 KiB 上限，支持 `before` 游标翻页，展示发送者 ID、`[bot]` 标记、引用关系与附件列表）。 |
| `download_attachment` | `chat_id`, `message_id`, `save_dir?`, `attachment_id?`, `filename?` | 下载指定消息中的附件到本地，内置自动重试、25 MB 限制、原文件名保留与 SHA-256 校验。 |
| `react` | `chat_id`, `message_id`, `emoji` | 为消息添加原生 Emoji（如 `👀`、`✅`）或服务器自定义表情（`<:name:id>`）。 |
| `edit_message` | `chat_id`, `message_id`, `text` | 编辑本机器人自己已发出的消息（适合长耗时编译/评测的进度刷新）。 |
| `create_thread` | `chat_id`, `name`, `message_id?` | 在白名单频道中创建新讨论串，或挂载在指定 `message_id` 下创建子 Thread。 |
| `discord_status` | *(无)* | 查看当前网关连接状态、内存/缓存指标、已绑定的 `conversationId`、入站队列深度与访问策略摘要。 |

---

## 版本升级与热更新说明

* **`.env` 与 `access.json` 修改：** 运行中**即时生效**，无需重启 `agy`。
* **CLI 与 Hook 更新 (`runtime/cli.cjs`)：** 下一次执行 CLI 命令或触发 `PreInvocation` Hook 时立即生效。
* **MCP 服务与网关更新 (`runtime/mcp-server.cjs`)：** 由于 `./bin/agy-discord-mcp` 在会话期间以常驻子进程方式运行，同步更新磁盘上的 `runtime/mcp-server.cjs` 后，**需要重启当前 `agy` 会话（或重启对应的 MCP Server 进程）**，运行中的网关与工具逻辑才会切换到新版本代码。

---

## 开发构建与质量门禁

```bash
npm ci
npm run build
npm run check
```

`npm run check` 会依次执行 Shell/JS 语法检查、全量单元与集成测试（含附件两步上传、失败重试、下载 SHA-256 校验、防越权与防死循环测试）、运行时打包一致性检查 (`build:check`) 以及包清单与敏感文件扫描 (`smoke`)。

## 开源协议

MIT — 详见 [LICENSE](LICENSE) 与 [plugins/agy-discord-channel/THIRD_PARTY_NOTICES.txt](plugins/agy-discord-channel/THIRD_PARTY_NOTICES.txt)。
