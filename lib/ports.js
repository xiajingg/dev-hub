'use strict';

// 端口 / 进程归属探测。全部基于 lsof —— 实测在受限环境下 lsof 仍可用，且能同时给出
// 监听端口、进程 cwd、可执行文件路径，信息量足够。

const fs = require('fs');
const path = require('path');
const { exec } = require('./exec');

// macOS 上 /tmp 是 /private/tmp 的软链接，lsof 报的是解析后的真实路径，
// 直接拿字符串比较会误判成「不同目录」。所有路径比较前统一走这里。
function normPath(p) {
  if (!p) return p;
  try {
    return fs.realpathSync(p);
  } catch (_) {
    return path.resolve(p);
  }
}

function parseAddrPort(addr) {
  const m = /:(\d+)$/.exec(String(addr || ''));
  return m ? Number(m[1]) : null;
}

// 所有处于 LISTEN 的 TCP 端口。返回 [{ pid, cmd, addrs:[], ports:[] }]
async function listeners() {
  const r = await exec('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn']);
  if (!r.ok && !r.stdout.trim()) return [];
  const out = [];
  let cur = null;
  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    const tag = line[0];
    const val = line.slice(1);
    if (tag === 'p') {
      cur = { pid: Number(val), cmd: '', addrs: [], ports: [] };
      out.push(cur);
    } else if (cur && tag === 'c') {
      cur.cmd = val;
    } else if (cur && tag === 'n') {
      cur.addrs.push(val);
      const p = parseAddrPort(val);
      if (p && !cur.ports.includes(p)) cur.ports.push(p);
    }
  }
  return out.filter((x) => x.pid && x.ports.length);
}

// 批量取进程的工作目录。返回 { pid: cwd }
async function cwdsOfPids(pids) {
  const list = (pids || []).filter(Boolean);
  const map = {};
  if (!list.length) return map;
  const r = await exec('lsof', ['-a', '-p', list.join(','), '-d', 'cwd', '-F', 'pn']);
  if (!r.ok && !r.stdout.trim()) return map;
  let curPid = null;
  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    if (line[0] === 'p') curPid = Number(line.slice(1));
    else if (line[0] === 'n' && curPid) map[curPid] = normPath(line.slice(1));
  }
  return map;
}

// 指定端口是否被占用。lsof 无匹配时退出码为 1 且 stdout 为空 —— 属正常，不是错误。
async function portOwner(port) {
  const r = await exec('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-F', 'pcn']);
  if (!r.stdout.trim()) return null;
  let pid = null;
  let cmd = '';
  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'c' && !cmd) cmd = line.slice(1);
  }
  return pid ? { pid, cmd } : null;
}

// 指定 pid 集合各自监听的端口
async function portsOfPids(pids) {
  const list = (pids || []).filter(Boolean);
  if (!list.length) return [];
  const r = await exec('lsof', ['-nP', '-a', '-p', list.join(','), '-iTCP', '-sTCP:LISTEN', '-F', 'pn']);
  if (!r.stdout.trim()) return [];
  const found = [];
  for (const line of r.stdout.split('\n')) {
    if (line[0] === 'n') {
      const p = parseAddrPort(line.slice(1));
      if (p && !found.includes(p)) found.push(p);
    }
  }
  return found;
}

// ★ 按工作目录反查监听端口。
// 这是最可靠的一招：不依赖 ps，且对「平台启动的」和「你在终端手动启动的」一视同仁。
async function portsByCwd(cwd) {
  const target = normPath(cwd);
  const ls = await listeners();
  if (!ls.length) return [];
  const cwds = await cwdsOfPids(ls.map((x) => x.pid));
  const hit = [];
  for (const l of ls) {
    if (cwds[l.pid] && cwds[l.pid] === target) hit.push(...l.ports);
  }
  return Array.from(new Set(hit)).sort((a, b) => a - b);
}

module.exports = { listeners, cwdsOfPids, portOwner, portsOfPids, portsByCwd, parseAddrPort, normPath };
