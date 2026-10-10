'use strict';

// 进程层：拉起 / 杀掉 / 存活与资源探测。
//
// 两个核心设计（都踩过坑）：
//  1) 子进程 detached + stdio 直连日志文件 fd。用 pipe 的话平台一退出，子进程写 stdout
//     会收到 SIGPIPE 直接死掉 —— 而需求恰恰是「平台关了，项目还在跑」。
//  2) detached 让子进程成为新进程组组长（pgid === pid，内核保证），所以杀进程用
//     process.kill(-pid) 一次干掉整棵树。只 kill 父 PID 会留下占着端口的孤儿进程。

const fs = require('fs');
const { spawn } = require('child_process');
const { exec } = require('./exec');
const logs = require('./logs');
const ports = require('./ports');

// 非登录 shell 的 PATH 常常缺这些，导致找不到 npm / pnpm / go
const EXTRA_PATH = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

// 平台自己所在的进程组。绝对不允许对它下手，否则等于自杀。
let ownPgid = null;

async function initSelf() {
  const r = await exec('/bin/ps', ['-o', 'pgid=', '-p', String(process.pid)]);
  const n = parseInt(r.stdout.trim(), 10);
  ownPgid = Number.isFinite(n) && n > 0 ? n : process.pid;
  return ownPgid;
}

function buildEnv(extra) {
  const env = Object.assign({}, process.env, extra || {});
  const parts = String(env.PATH || '')
    .split(':')
    .filter(Boolean);
  for (const p of EXTRA_PATH) if (!parts.includes(p)) parts.push(p);
  env.PATH = parts.join(':');
  return env;
}

function isAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // 存在但无权限 → 仍算活着
  }
}

async function pgidOf(pid) {
  const r = await exec('/bin/ps', ['-o', 'pgid=', '-p', String(pid)]);
  const n = parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// 进程组里是否还有活着的进程。ps 不可用时返回 null（无法判断），调用方需降级处理。
async function groupAlive(pgid) {
  if (!pgid || pgid <= 1) return null;
  const r = await exec('/bin/ps', ['-o', 'pid=', '-g', String(pgid)]);
  if (!r.ok && !r.stdout.trim()) return null;
  return r.stdout.trim().split(/\s+/).filter(Boolean).length > 0;
}

function sumRss(text) {
  const nums = String(text)
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) * 1024; // ps 的 rss 单位是 KB
}

async function rssOfPgid(pgid) {
  if (!pgid || pgid <= 1) return null;
  const r = await exec('/bin/ps', ['-o', 'rss=', '-g', String(pgid)]);
  return r.ok ? sumRss(r.stdout) : null;
}

async function rssOfPid(pid) {
  if (!pid) return null;
  const r = await exec('/bin/ps', ['-o', 'rss=', '-p', String(pid)]);
  return r.ok ? sumRss(r.stdout) : null;
}

// top 兜底（ps 被策略禁掉时用）。macOS 的 mem 列形如 12M+ / 512K。
async function rssViaTop(pid) {
  if (!pid) return null;
  const r = await exec('/usr/bin/top', ['-l', '1', '-stats', 'pid,mem', '-pid', String(pid)]);
  if (!r.ok) return null;
  const m = new RegExp('^\\s*' + pid + '\\s+([0-9.]+)([KMG])', 'm').exec(r.stdout);
  if (!m) return null;
  const unit = { K: 1024, M: 1024 * 1024, G: 1024 * 1024 * 1024 }[m[2]];
  return Math.round(Number(m[1]) * unit);
}

// 内存占用（字节）。优先按进程组汇总（更接近真实占用），失败再退到单进程，再退到 top。
async function memoryOf(entry) {
  const pid = entry && entry.pid;
  if (!pid || !isAlive(pid)) return null;
  const byGroup = await rssOfPgid(entry.pgid);
  if (byGroup != null) return byGroup;
  const byPid = await rssOfPid(pid);
  if (byPid != null) return byPid;
  return rssViaTop(pid);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function start(project, onExit) {
  logs.rotateIfNeeded(project.id);
  const file = logs.logPathFor(project.id);
  const fd = fs.openSync(file, 'a');

  let child;
  try {
    child = spawn(project.command, [], {
      cwd: project.cwd,
      env: buildEnv(project.env),
      shell: true,
      detached: true,
      stdio: ['ignore', fd, fd],
    });
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch (_) {
      /* ignore */
    }
    return { ok: false, error: err.message };
  }
  // 父进程不再需要这个 fd，子进程已持有自己的副本
  try {
    fs.closeSync(fd);
  } catch (_) {
    /* ignore */
  }

  const pid = child.pid;
  child.unref();

  // 必须挂 error 监听，否则 detached + unref 下的 spawn 失败会变成未捕获异常
  child.on('error', (err) => {
    if (typeof onExit === 'function') onExit({ pid, code: -1, signal: null, error: err.message });
  });
  if (typeof onExit === 'function') {
    child.on('exit', (code, signal) => onExit({ pid, code, signal }));
  }

  return { ok: true, pid, pgid: pid };
}

function safeKill(target, signal) {
  try {
    process.kill(target, signal);
    return true;
  } catch (_) {
    return false;
  }
}

async function stop(entry) {
  const pid = entry && entry.pid;
  if (!pid || !isAlive(pid)) {
    // 父进程已死，但可能有孤儿孙子进程还占着端口 —— 用进程组再确认一次
    const g = await groupAlive(entry && entry.pgid);
    if (g !== true) return { ok: true, alreadyStopped: true };
  }

  let pgid = (entry && entry.pgid) || (await pgidOf(pid)) || pid;
  // 安全闸：绝不误杀平台自己所在的进程组
  if (pgid <= 1 || pgid === process.pid || (ownPgid && pgid === ownPgid)) pgid = null;
  const groupTarget = pgid ? -pgid : null;

  const alive = async () => {
    if (isAlive(pid)) return true;
    const g = await groupAlive(pgid);
    return g === true;
  };

  if (groupTarget) safeKill(groupTarget, 'SIGTERM');
  else safeKill(pid, 'SIGTERM');

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!(await alive())) return { ok: true, killed: 'SIGTERM' };
    await sleep(150);
  }

  if (groupTarget) safeKill(groupTarget, 'SIGKILL');
  else safeKill(pid, 'SIGKILL');
  await sleep(400);

  const stillAlive = await alive();
  return { ok: !stillAlive, killed: 'SIGKILL', alive: stillAlive };
}

// 执行用户自定义命令（例如「停止命令」）。
// 关键：**不 detached** —— 平台要等它跑完，才能判断服务到底停没停。
// 输出照样写进项目日志，这样用户能看到脚本报了什么错。
function runCommand(project, command, timeoutMs) {
  return new Promise((resolve) => {
    const file = logs.logPathFor(project.id);
    let fd;
    try {
      fd = fs.openSync(file, 'a');
      fs.writeSync(fd, '\n[dev-hub] 执行自定义命令：' + command + '\n');
    } catch (err) {
      return resolve({ code: -1, error: err.message });
    }

    const closeFd = () => {
      try {
        fs.closeSync(fd);
      } catch (_) {
        /* ignore */
      }
    };

    let child;
    try {
      child = spawn(command, [], {
        cwd: project.cwd,
        env: buildEnv(project.env),
        shell: true,
        stdio: ['ignore', fd, fd],
      });
    } catch (err) {
      closeFd();
      return resolve({ code: -1, error: err.message });
    }

    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      closeFd();
      resolve(r);
    };

    const timer = setTimeout(() => {
      safeKill(child.pid, 'SIGKILL');
      finish({ code: null, timeout: true });
    }, timeoutMs || 30000);

    child.on('error', (err) => finish({ code: -1, error: err.message }));
    child.on('exit', (code, signal) => finish({ code, signal }));
  });
}

// 启动后探测端口。主用「按 cwd 反查监听端口」——不依赖 ps，且对终端手动启动的进程同样有效。
async function detectPorts(project, delays) {
  const tries = delays || [600, 1200, 2500, 4000];
  for (const d of tries) {
    await sleep(d);
    const byCwd = await ports.portsByCwd(project.cwd);
    if (byCwd.length) return byCwd;
  }
  return [];
}

module.exports = {
  initSelf,
  buildEnv,
  isAlive,
  pgidOf,
  groupAlive,
  memoryOf,
  start,
  stop,
  runCommand,
  detectPorts,
};
