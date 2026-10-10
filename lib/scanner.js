'use strict';

// 扫描当前正在监听端口的进程，生成「可导入」候选。
//
// 三条硬限制（UI 上必须如实告知用户）：
//  1) 拿到的是派生后的子进程命令行，不一定等于你当初敲的那条（npm run dev → node .../vite.js）
//  2) 环境变量拿不到（macOS 不允许读他人进程 env）
//  3) 只能发现此刻正在跑的进程

const os = require('os');
const path = require('path');
const { exec } = require('./exec');
const ports = require('./ports');
const cmdparse = require('./cmdparse');
const portclass = require('./portclass');

const HOME = ports.normPath(os.homedir());
// 平台自己的目录，永远排除
const SELF_DIR = ports.normPath(path.join(__dirname, '..'));

// 需要排除的非项目目录（相对 HOME 判断）。隐藏目录由下面的通用规则处理。
const EXCLUDE_REL = [/^\/Library\b/, /^\/Applications\b/, /^\/\.Trash\b/];

// 时间戳命名的目录（2026-10-10-17-26-26 这种）通常是产物 / 临时工作区，不是项目
const TIMESTAMP_DIR = /\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}/;

function isProjectDir(cwd) {
  if (!cwd) return false;
  const abs = ports.normPath(cwd);
  if (!abs.startsWith(HOME + path.sep)) return false;
  if (abs === SELF_DIR || abs.startsWith(SELF_DIR + path.sep)) return false;

  const rel = abs.slice(HOME.length);
  // 隐藏目录（.cache / .config 等）是工具配置目录，不是项目
  if (/(^|\/)\.[^/]/.test(rel)) return false;
  if (TIMESTAMP_DIR.test(rel)) return false;
  return !EXCLUDE_REL.some((re) => re.test(rel));
}

// 批量取命令行与进程组。ps 不可用时返回空对象，由调用方降级。
async function commandsOfPids(pids) {
  const list = (pids || []).filter(Boolean);
  const map = {};
  if (!list.length) return map;
  const r = await exec('/bin/ps', ['-o', 'pid=,pgid=,command=', '-p', list.join(',')]);
  if (!r.ok && !r.stdout.trim()) return map;
  for (const line of r.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) map[Number(m[1])] = { pgid: Number(m[2]), command: m[3].trim() };
  }
  return map;
}

async function scan(projects) {
  const ls = await ports.listeners();
  if (!ls.length) return [];

  const pids = ls.map((x) => x.pid);
  const cwds = await ports.cwdsOfPids(pids);
  const cmds = await commandsOfPids(pids);

  // 按工作目录聚合：同一个项目的父子进程可能都持有 fd，只保留一条候选
  const byCwd = new Map();

  for (const l of ls) {
    const cwd = cwds[l.pid];
    if (!cwd || !isProjectDir(cwd)) continue;

    const info = cmds[l.pid];
    let entry = byCwd.get(cwd);
    if (!entry) {
      entry = {
        key: cwd,
        cwd,
        name: path.basename(cwd),
        entries: [],
        pid: l.pid,
        pgid: info ? info.pgid : null,
        command: (info && info.command) || '',
        commandSource: info ? 'ps' : 'lsof',
        procName: l.cmd,
      };
      byCwd.set(cwd, entry);
    }

    // 收集端口明细（带绑定地址），后面统一分类
    for (const addr of l.addrs) {
      const port = ports.parseAddrPort(addr);
      if (!port) continue;
      const bindHost = ports.bindHostOfAddr(addr);
      const hit = entry.entries.find((x) => x.port === port && x.bindHost === bindHost);
      if (hit) continue;
      entry.entries.push({
        port,
        scope: bindHost === '*' ? 'all' : 'local',
        cmd: l.cmd,
        pid: l.pid,
        addr,
        host: ports.hostOfAddr(addr),
        bindHost,
      });
    }

    // 优先保留能拿到完整命令行的那条
    if (info && info.command && entry.commandSource !== 'ps') {
      entry.command = info.command;
      entry.commandSource = 'ps';
      entry.pid = l.pid;
      entry.pgid = info.pgid || entry.pgid;
    }
  }

  const registered = new Set((projects || []).map((p) => ports.normPath(p.cwd || '.')));

  const out = [];

  for (const e of byCwd.values()) {
    // 用分类器挑主端口，避免把 Electron 内部端口 / JMX 管理端口当成服务端口导进去
    const picked = portclass.pick(e.entries, null);
    const primary = e.entries.find((x) => x.port === picked.port);
    e.ports = picked.all;
    e.port = picked.port;
    // 绑在任意地址上的不记 host（留空 = 未知，冲突判定走保守分支）
    e.host = primary && primary.bindHost !== '*' ? primary.host : '';

    // ★ 去重：唯一键是「地址 + 端口」。
    // 双栈下 127.0.0.1:5173 和 [::1]:5173 是两个不同的 socket，不该互相去重。
    // 任一方的地址未知时走保守判定（ports.hostsConflict）。
    const clash = [];
    for (const en of e.entries) {
      const h = en.bindHost === '*' ? '' : en.host;
      const owner = (projects || []).find(
        (p) => Number(p.port) === en.port && ports.hostsConflict(h, p.host || '')
      );
      if (owner) clash.push({ port: en.port, host: h, by: owner.name });
    }
    e.hiddenPorts = picked.hidden;
    delete e.entries;

    if (!e.command) e.command = e.procName || '';
    e.registered = registered.has(e.cwd);

    e.portClash = clash;
    e.duplicate = clash.length > 0 || (e.ports.length === 0 && e.registered);
    // 注意用 e.duplicate 判断，不能用 e.registered —— 目录登记过但端口不同（前后端拆两条）
    // 或者端口撞了但地址不同（双栈共存）时，这条其实是**可以导入**的，不该挂重复说明。
    e.duplicateReason = clash.length
      ? clash.map((c) => (c.host || '*') + ':' + c.port + ' 已被「' + c.by + '」认领').join('、')
      : e.duplicate
      ? '该目录已登记，且这条没有可区分的端口'
      : '';

    // 命令行来源为 lsof 时拿到的只是进程名（java / node / python3.11），不是完整命令行 ——
    // 通常说明 ps 不可用，UI 上必须标出来提醒用户补全，不能让人误信。
    e.commandReliable = e.commandSource === 'ps' && !!e.command;
    // 与手动登记保持同一格式：cd <目录> && <命令>
    e.suggestedCommand = e.command ? cmdparse.cdPrefix(e.cwd) + ' && ' + e.command : cmdparse.cdPrefix(e.cwd) + ' && ';
    out.push(e);
  }

  // 排序：有服务端口且没被占用的排最前，重复项沉底
  out.sort((a, b) => {
    const rank = (x) => (x.duplicate ? 2 : x.ports.length ? 0 : 1);
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });
  return out;
}

module.exports = { scan, isProjectDir, commandsOfPids };
