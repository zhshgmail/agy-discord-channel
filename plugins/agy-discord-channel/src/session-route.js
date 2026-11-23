'use strict';

const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readProcStat(pid, procRoot = '/proc') {
  try {
    const raw = fs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8');
    const closeIdx = raw.lastIndexOf(')');
    if (closeIdx < 0) return null;
    const comm = raw.slice(raw.indexOf('(') + 1, closeIdx);
    const fields = raw.slice(closeIdx + 2).trim().split(/\s+/);
    const ppid = Number.parseInt(fields[1], 10);
    const startTicks = fields[19] || '';
    let cmdline = '';
    try {
      cmdline = fs
        .readFileSync(path.join(procRoot, String(pid), 'cmdline'), 'utf8')
        .replace(/\0+/g, ' ')
        .trim();
    } catch {}
    return { pid: Number(pid), ppid, comm, startTicks, cmdline };
  } catch {
    return null;
  }
}

function isProcessAliveWithTicks(pid, expectedStartTicks = '', procRoot = '/proc') {
  const numPid = Number(pid);
  if (!Number.isInteger(numPid) || numPid <= 0) return false;
  const stat = readProcStat(numPid, procRoot);
  if (stat) {
    if (expectedStartTicks && stat.startTicks && stat.startTicks !== String(expectedStartTicks)) {
      return false;
    }
    return true;
  }
  if (!fs.existsSync(procRoot)) {
    try {
      process.kill(numPid, 0);
      return true;
    } catch (err) {
      return err?.code === 'EPERM';
    }
  }
  return false;
}

function isAgyProcess(stat) {
  if (!stat) return false;
  if (stat.comm === 'agy') return true;
  const firstToken = (stat.cmdline.split(/\s+/)[0] || '').trim();
  const base = path.basename(firstToken);
  return base === 'agy';
}

function findAncestorAgyProcess(startPid = process.ppid, procRoot = '/proc') {
  let pid = Number(startPid);
  const visited = new Set();
  while (Number.isInteger(pid) && pid > 1 && !visited.has(pid)) {
    visited.add(pid);
    const stat = readProcStat(pid, procRoot);
    if (!stat) break;
    if (isAgyProcess(stat)) {
      return {
        pid: stat.pid,
        startTicks: stat.startTicks,
        cmdline: stat.cmdline,
      };
    }
    pid = stat.ppid;
  }
  return null;
}

function discoverConversationFromProcFd(agyPid, procRoot = '/proc') {
  if (!Number.isInteger(Number(agyPid)) || Number(agyPid) <= 0) return '';
  const fdDir = path.join(procRoot, String(agyPid), 'fd');
  let entries;
  try {
    entries = fs.readdirSync(fdDir);
  } catch {
    return '';
  }
  for (const fd of entries) {
    try {
      const target = fs.readlinkSync(path.join(fdDir, fd));
      const match = /\/presence\/([0-9a-f-]{36})\.lock$/i.exec(target);
      if (match && UUID_RE.test(match[1])) {
        return match[1];
      }
    } catch {}
  }
  return '';
}

function acquireReceiverLock(paths, ownerAgy = null, procRoot = '/proc') {
  fs.mkdirSync(path.dirname(paths.receiverLockPath), { recursive: true, mode: 0o700 });
  const myStat = readProcStat(process.pid, procRoot);
  const candidate = {
    version: 2,
    generation: crypto.randomUUID(),
    mcpPid: process.pid,
    mcpStartTicks: myStat?.startTicks || '',
    ownerAgyPid: ownerAgy?.pid || null,
    ownerAgyStartTicks: ownerAgy?.startTicks || '',
    instance: paths.instance,
    stateDir: paths.stateDir,
    acquiredAt: new Date().toISOString(),
  };

  let reclaimedStalePid = null;
  try {
    const existing = JSON.parse(fs.readFileSync(paths.receiverLockPath, 'utf8'));
    if (existing && existing.mcpPid && existing.mcpPid !== process.pid) {
      if (isProcessAliveWithTicks(existing.mcpPid, existing.mcpStartTicks, procRoot)) {
        return { acquired: false, holder: existing, reclaimedStalePid: null };
      }
      reclaimedStalePid = existing.mcpPid;
    }
  } catch {}

  const tmp = `${paths.receiverLockPath}.${process.pid}.${candidate.generation}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, paths.receiverLockPath);
  return { acquired: true, holder: candidate, reclaimedStalePid };
}

function isCurrentReceiverLock(paths, expectedHolder, procRoot = '/proc') {
  if (!expectedHolder) return false;
  try {
    const current = JSON.parse(fs.readFileSync(paths.receiverLockPath, 'utf8'));
    if (!current || current.mcpPid !== process.pid) return false;
    if (expectedHolder.generation && current.generation !== expectedHolder.generation) {
      return false;
    }
    return isProcessAliveWithTicks(current.mcpPid, current.mcpStartTicks, procRoot);
  } catch {
    return false;
  }
}

function releaseReceiverLock(paths, expectedHolder = null) {
  try {
    const existing = JSON.parse(fs.readFileSync(paths.receiverLockPath, 'utf8'));
    if (
      existing?.mcpPid === process.pid &&
      (!expectedHolder?.generation || existing.generation === expectedHolder.generation)
    ) {
      fs.rmSync(paths.receiverLockPath, { force: true });
      return true;
    }
  } catch {}
  return false;
}

function recordHookSessionBind(paths, hookPayload = {}, env = process.env, procRoot = '/proc') {
  const conversationId = String(
    hookPayload?.conversationId || env.ANTIGRAVITY_CONVERSATION_ID || '',
  ).trim();
  if (!UUID_RE.test(conversationId)) {
    return { recorded: false, reason: 'missing_conversation_id' };
  }

  const ownerAgy = findAncestorAgyProcess(process.ppid, procRoot);
  let prior = null;
  if (ownerAgy?.pid) {
    try {
      const existing = JSON.parse(
        fs.readFileSync(path.join(paths.sessionsDir, `agy-${ownerAgy.pid}.json`), 'utf8'),
      );
      if (
        existing &&
        (!ownerAgy.startTicks ||
          !existing.agyStartTicks ||
          existing.agyStartTicks === ownerAgy.startTicks)
      ) {
        prior = existing;
      }
    } catch {}
  }

  const record = {
    conversationId,
    agyPid: ownerAgy?.pid || null,
    agyStartTicks: ownerAgy?.startTicks || '',
    agentapiExe: env.ANTIGRAVITY_AGENTAPI_EXE || prior?.agentapiExe || '',
    lsAddress: env.ANTIGRAVITY_LS_ADDRESS || prior?.lsAddress || '',
    csrfToken: env.ANTIGRAVITY_CSRF_TOKEN || prior?.csrfToken || '',
    projectId: env.ANTIGRAVITY_PROJECT_ID || prior?.projectId || '',
    appDataDir: env.ANTIGRAVITY_APP_DATA_DIR || prior?.appDataDir || '',
    cwd: hookPayload?.cwd || process.cwd(),
    hookEventName: hookPayload?.hookEventName || '',
    updatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(paths.sessionsDir, { recursive: true, mode: 0o700 });

  // Clean up dead session records
  try {
    for (const file of fs.readdirSync(paths.sessionsDir)) {
      const m = /^agy-(\d+)\.json$/.exec(file);
      if (!m) continue;
      const p = path.join(paths.sessionsDir, file);
      try {
        const old = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (!isProcessAliveWithTicks(Number(m[1]), old?.agyStartTicks || '', procRoot)) {
          fs.rmSync(p, { force: true });
        }
      } catch {}
    }
  } catch {}

  if (ownerAgy?.pid) {
    const targetFile = path.join(paths.sessionsDir, `agy-${ownerAgy.pid}.json`);
    const tmp = `${targetFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, targetFile);
  }

  const latestFile = path.join(paths.sessionsDir, 'latest.json');
  const tmpLatest = `${latestFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmpLatest, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpLatest, latestFile);

  return { recorded: true, record };
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function resolveDefaultAgentapiBin(env = process.env) {
  if (env.ANTIGRAVITY_AGENTAPI_EXE && fs.existsSync(env.ANTIGRAVITY_AGENTAPI_EXE)) {
    return { bin: env.ANTIGRAVITY_AGENTAPI_EXE, subcommandPrefix: ['agentapi'] };
  }
  const home = env.HOME || os.homedir();
  const wrapper = path.join(home, '.gemini', 'antigravity-cli', 'bin', 'agentapi');
  if (fs.existsSync(wrapper)) {
    return { bin: wrapper, subcommandPrefix: [] };
  }
  const localAgy = path.join(home, '.local', 'bin', 'agy');
  if (fs.existsSync(localAgy)) {
    return { bin: localAgy, subcommandPrefix: ['agentapi'] };
  }
  return { bin: 'agy', subcommandPrefix: ['agentapi'] };
}

function resolveSessionRoute(config, ownerAgy = null, procRoot = '/proc') {
  const { paths, env } = config;
  let hookRecord = null;

  if (ownerAgy?.pid) {
    const candidate = readJsonSafe(path.join(paths.sessionsDir, `agy-${ownerAgy.pid}.json`));
    if (
      candidate &&
      (!ownerAgy.startTicks ||
        !candidate.agyStartTicks ||
        candidate.agyStartTicks === ownerAgy.startTicks)
    ) {
      hookRecord = candidate;
    }
  } else {
    const latest = readJsonSafe(path.join(paths.sessionsDir, 'latest.json'));
    if (
      latest &&
      (!latest.agyPid || isProcessAliveWithTicks(latest.agyPid, latest.agyStartTicks, procRoot))
    ) {
      hookRecord = latest;
    }
  }

  const fdConvId = ownerAgy?.pid ? discoverConversationFromProcFd(ownerAgy.pid, procRoot) : '';
  const conversationId =
    fdConvId ||
    hookRecord?.conversationId ||
    (UUID_RE.test(env.ANTIGRAVITY_CONVERSATION_ID || '') ? env.ANTIGRAVITY_CONVERSATION_ID : '');

  const lsAddress = env.ANTIGRAVITY_LS_ADDRESS || hookRecord?.lsAddress || '';
  const csrfToken = env.ANTIGRAVITY_CSRF_TOKEN || hookRecord?.csrfToken || '';
  const projectId = env.ANTIGRAVITY_PROJECT_ID || hookRecord?.projectId || '';
  const appDataDir = env.ANTIGRAVITY_APP_DATA_DIR || hookRecord?.appDataDir || '';
  const exeOverride = env.ANTIGRAVITY_AGENTAPI_EXE || hookRecord?.agentapiExe || '';

  const agentapiSpec = resolveDefaultAgentapiBin({
    ...env,
    ...(exeOverride ? { ANTIGRAVITY_AGENTAPI_EXE: exeOverride } : {}),
  });

  if (!conversationId) {
    return {
      ready: false,
      reason: 'waiting_for_conversation_id',
      ownerAgyPid: ownerAgy?.pid || null,
      lsAddressPresent: Boolean(lsAddress),
    };
  }
  if (!lsAddress || !csrfToken) {
    return {
      ready: false,
      reason: 'waiting_for_ls_credentials',
      conversationId,
      ownerAgyPid: ownerAgy?.pid || null,
    };
  }

  return {
    ready: true,
    conversationId,
    conversationSource: fdConvId ? 'proc_presence_fd' : hookRecord?.conversationId ? 'session_hook' : 'env',
    ownerAgyPid: ownerAgy?.pid || hookRecord?.agyPid || null,
    lsAddress,
    csrfToken,
    projectId,
    appDataDir,
    agentapiBin: agentapiSpec.bin,
    agentapiPrefix: agentapiSpec.subcommandPrefix,
  };
}

function deliverToAgySession(route, title, content, deps = {}) {
  if (!route || !route.ready) {
    return Promise.reject(new Error(route?.reason || 'session_route_not_ready'));
  }
  const execFileImpl = deps.execFile || execFile;
  const args = [
    ...route.agentapiPrefix,
    'send-message',
    `--title=${title}`,
    route.conversationId,
    content,
  ];
  const childEnv = {
    ...process.env,
    ANTIGRAVITY_LS_ADDRESS: route.lsAddress,
    ANTIGRAVITY_CSRF_TOKEN: route.csrfToken,
    ...(route.projectId ? { ANTIGRAVITY_PROJECT_ID: route.projectId } : {}),
    ...(route.appDataDir ? { ANTIGRAVITY_APP_DATA_DIR: route.appDataDir } : {}),
  };

  return new Promise((resolve, reject) => {
    execFileImpl(
      route.agentapiBin,
      args,
      { env: childEnv, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || stdout || err.message || '').trim();
          return reject(new Error(`agentapi send-message failed: ${detail}`));
        }
        try {
          const parsed = JSON.parse(stdout || '{}');
          if (!parsed?.response?.sendMessage) {
            return reject(new Error(`unexpected agentapi response: ${(stdout || '').slice(0, 200)}`));
          }
          return resolve(parsed.response.sendMessage);
        } catch (parseErr) {
          return reject(new Error(`invalid agentapi JSON output: ${parseErr.message}`));
        }
      },
    );
  });
}

module.exports = {
  acquireReceiverLock,
  deliverToAgySession,
  discoverConversationFromProcFd,
  findAncestorAgyProcess,
  isCurrentReceiverLock,
  isProcessAliveWithTicks,
  readProcStat,
  recordHookSessionBind,
  releaseReceiverLock,
  resolveSessionRoute,
};
