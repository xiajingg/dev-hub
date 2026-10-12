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

// lsof 的绑定地址 → 「绑定主机」，用于判断端口冲突。
// 绑在任意地址（* / 0.0.0.0 / [::]）会占住该端口的**所有地址族**，统一记作 '*'。
// 注意：127.0.0.1 和 ::1 是两个不同的 socket，内核允许它们同时监听同一端口号 ——
// 所以判断冲突必须带上地址，不能只看端口号。
function bindHostOfAddr(addr) {
  const m = /^(.*):(\d+)$/.exec(String(addr || ''));
  const h = m ? m[1] : '';
  if (!h || h === '0.0.0.0' || h === '[::]') return '*';
  return h;
}

// lsof 的绑定地址 → 「浏览器能访问的主机名」，用于拼 URL。
// 只监听 IPv6 回环的服务必须用 [::1] 访问，拼 127.0.0.1 会连不上。
function hostOfAddr(addr) {
  const h = bindHostOfAddr(addr);
  return h === '*' ? '127.0.0.1' : h;
}

// 两个绑定主机是否算冲突。任一未知 → 保守认为冲突。
function hostsConflict(a, b) {
  if (!a || !b) return true;
  if (a === '*' || b === '*') return true;
  return a === b;
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

// 某端口上所有监听者（可能不止一个 —— 双栈下 IPv4 和 IPv6 会各有一个）。
// lsof 无匹配时退出码为 1 且 stdout 为空，属正常，不是错误。
async function portOwners(port) {
  const r = await exec('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-F', 'pcn']);
  if (!r.stdout.trim()) return [];
  const out = [];
  let cur = null;
  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    const tag = line[0];
    const val = line.slice(1);
    if (tag === 'p') {
      cur = { pid: Number(val), cmd: '', addrs: [] };
      out.push(cur);
    } else if (cur && tag === 'c') {
      cur.cmd = val;
    } else if (cur && tag === 'n') {
      cur.addrs.push(val);
    }
  }
  return out.filter((x) => x.pid);
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

// ★ 按工作目录反查监听端口，**带上绑定地址**。
// 这是最可靠的一招：不依赖 ps，且对「平台启动的」和「你在终端手动启动的」一视同仁。
async function portEntriesByCwd(cwd) {
  const target = normPath(cwd);
  const ls = await listeners();
  if (!ls.length) return [];
  const cwds = await cwdsOfPids(ls.map((x) => x.pid));
  const out = [];
  const seen = new Set();
  for (const l of ls) {
    if (cwds[l.pid] !== target) continue;
    for (const addr of l.addrs) {
      const port = parseAddrPort(addr);
      if (!port) continue;
      const key = bindHostOfAddr(addr) + ':' + port;
      if (seen.has(key)) continue;
      seen.add(key);
      // pid / cmd 一并带上：调用方（守护进程探测、停止后的复活检测）要靠它定位进程
      out.push({
        port,
        addr,
        host: hostOfAddr(addr),
        bindHost: bindHostOfAddr(addr),
        pid: l.pid,
        cmd: l.cmd,
      });
    }
  }
  out.sort((a, b) => a.port - b.port);
  return out;
}

async function portsByCwd(cwd) {
  const entries = await portEntriesByCwd(cwd);
  return Array.from(new Set(entries.map((e) => e.port))).sort((a, b) => a - b);
}

module.exports = {
  listeners,
  cwdsOfPids,
  portOwners,
  portsOfPids,
  portsByCwd,
  portEntriesByCwd,
  parseAddrPort,
  normPath,
  hostOfAddr,
  bindHostOfAddr,
  hostsConflict,
};
