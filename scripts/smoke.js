'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SERVER_VERSION, toolDefinitions } = require('../plugins/agy-discord-channel/src/mcp-server');

const repoRoot = path.resolve(__dirname, '..');
const pluginRoot = path.join(repoRoot, 'plugins', 'agy-discord-channel');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const pkg = readJson(path.join(repoRoot, 'package.json'));
const manifest = readJson(path.join(pluginRoot, 'plugin.json'));
const mcpConfig = readJson(path.join(pluginRoot, 'mcp_config.json'));
const hooksConfig = readJson(path.join(pluginRoot, 'hooks.json'));

assert.equal(manifest.name, 'agy-discord-channel', 'plugin.json name mismatch');
assert.equal(manifest.version, pkg.version, 'plugin.json version must match package.json');
assert.equal(SERVER_VERSION, pkg.version, 'SERVER_VERSION must match package.json');

assert.equal(
  mcpConfig.mcpServers?.discord?.command,
  './bin/agy-discord-mcp',
  'mcp_config.json must point to ./bin/agy-discord-mcp',
);
assert.ok(
  Array.isArray(hooksConfig['discord-session-bind']?.SessionStart),
  'hooks.json must declare SessionStart',
);
assert.ok(
  Array.isArray(hooksConfig['discord-session-bind']?.PreInvocation),
  'hooks.json must declare PreInvocation',
);

for (const lifecycle of ['preinstall', 'install', 'postinstall', 'prepare']) {
  assert.ok(!Object.hasOwn(pkg.scripts || {}, lifecycle), `package.json must not rely on ${lifecycle}`);
}

for (const relExec of ['bin/agy-discord', 'bin/agy-discord-mcp', 'hooks/session-bind.sh']) {
  const full = path.join(pluginRoot, relExec);
  assert.ok(fs.existsSync(full), `missing executable ${relExec}`);
  assert.notEqual(fs.statSync(full).mode & 0o111, 0, `${relExec} must be executable`);
}

for (const relBundle of [
  'runtime/mcp-server.cjs',
  'runtime/cli.cjs',
  'LICENSE',
  'THIRD_PARTY_NOTICES.txt',
  'rules/AGENTS.md',
  'skills/discord-configure/SKILL.md',
  'skills/discord-access/SKILL.md',
]) {
  assert.ok(fs.existsSync(path.join(pluginRoot, relBundle)), `missing ${relBundle} in plugin root`);
}

// Guard against accidentally committing secrets or state files
function walkNoSecrets(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkNoSecrets(full);
    } else {
      assert.notEqual(entry.name, '.env', `secret .env file must never exist in repo: ${full}`);
      assert.ok(
        !entry.name.endsWith('.token'),
        `token file must never exist in repo: ${full}`,
      );
    }
  }
}
walkNoSecrets(repoRoot);

const tools = toolDefinitions().map((t) => t.name);
for (const expected of [
  'reply',
  'fetch_messages',
  'react',
  'edit_message',
  'download_attachment',
  'create_thread',
  'discord_status',
]) {
  assert.ok(tools.includes(expected), `missing MCP tool: ${expected}`);
}

const agentsRule = fs.readFileSync(path.join(pluginRoot, 'rules', 'AGENTS.md'), 'utf8');
for (const requiredPhrase of [
  '<channel source="discord"',
  'Terminal output never reaches Discord',
  'is_bot="true"',
  'access.json',
]) {
  assert.ok(agentsRule.includes(requiredPhrase), `AGENTS.md missing contract: ${requiredPhrase}`);
}

process.stdout.write('smoke passed\n');
