'use strict';

// 守护进程探测：找出「杀不死」的进程背后是谁在保活。
//
// 为什么要这个：
//   进程被 launchd（KeepAlive）或 pm2 托管时，杀掉它会被**立刻重新拉起**。
//   在平台上的表现是「点停止 → 显示已停止 → 端口马上又被占」，而且永远接管不到它
//   （每次点启动都只能接管，来源永远标「外部启动」）。不告诉用户原因，这就是玄学。
//
// 判据都是硬的，不猜：
//   - launchd：launchctl list 里 PID 对得上的那个任务，再读它的 KeepAlive
//   - pm2    ：进程环境里有 PM2_HOME / pm_id
//   - 孤儿   ：ppid == 1（父进程已死，多半是 daemon 化的）

const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('./exec');

const LAUNCH_AGENTS = path.join(os.homedir(), 'Library', 'LaunchAgents');

// launchctl list 的每行是：PID<TAB>状态码<TAB>LABEL（未运行的 PID 列是 "-"）
async function launchdLabelOf(pid) {
  if (!pid) return null;
  const r = await exec('/bin/launchctl', ['list']);
  if (!r.ok) return null;
  for (const line of r.stdout.split('\n')) {
    const m = /^(\d+)\s+(-?\d+)\s+(\S+)\s*$/.exec(line.trim());
    if (m && Number(m[1]) === Number(pid)) return m[3];
  }
  return null;
}

// 读任务详情。KeepAlive 是「自动拉起」的开关，这里只看它。
//
// 坑：launchctl list <label> 的输出**不全** —— 实测它对一个 KeepAlive=true 的任务
// 只给出 OnDemand = false，压根没有 KeepAlive 这一行。所以判据以 plist 文件为准，
// launchctl 的输出只作为兜底（OnDemand=false 语义上等价于 KeepAlive）。
async function launchdInfo(label) {
  const out = { label, keepAlive: false, runAtLoad: false, plist: plistPathFor(label) };

  const r = await exec('/bin/launchctl', ['list', label]);
  if (r.ok) {
    if (/"KeepAlive"\s*=\s*(1|true|\{)/i.test(r.stdout)) out.keepAlive = true;
    if (/"OnDemand"\s*=\s*(0|false)/i.test(r.stdout)) out.keepAlive = true;
    if (/"RunAtLoad"\s*=\s*(1|true)/i.test(r.stdout)) out.runAtLoad = true;
  }

  if (out.plist) {
    try {
      const txt = fs.readFileSync(out.plist, 'utf8');
      // KeepAlive 可以是 <true/> 或 <dict>（条件保活），两种都算
      if (/<key>\s*KeepAlive\s*<\/key>\s*<(true\/|dict>)/i.test(txt)) out.keepAlive = true;
      if (/<key>\s*RunAtLoad\s*<\/key>\s*<true\/>/i.test(txt)) out.runAtLoad = true;
    } catch (_) {
      /* 读不到就只信 launchctl 的输出 */
    }
  }

  return out;
}

// 找到对应的 plist 文件，好给出可直接复制的卸载命令
function plistPathFor(label) {
  try {
    for (const n of fs.readdirSync(LAUNCH_AGENTS)) {
      if (!n.endsWith('.plist')) continue;
      const full = path.join(LAUNCH_AGENTS, n);
      if (fs.readFileSync(full, 'utf8').includes('<string>' + label + '</string>')) return full;
    }
  } catch (_) {
    /* 目录不存在或读不了 —— 不是错误 */
  }
  return null;
}

async function detect(pid) {
  const out = { pid: pid || null, launchd: null, pm2: false, orphan: false };
  if (!pid) return out;

  const pp = await exec('/bin/ps', ['-o', 'ppid=', '-p', String(pid)]);
  out.orphan = parseInt(pp.stdout.trim(), 10) === 1;

  const label = await launchdLabelOf(pid);
  if (label) out.launchd = await launchdInfo(label);

  const env = await exec('/bin/ps', ['eww', '-o', 'command=', '-p', String(pid)]);
  if (/PM2_HOME=|pm_id=/.test(env.stdout)) out.pm2 = true;

  return out;
}

// 一句话说清「为什么杀不掉」。没有守护时返回空串。
function describe(g) {
  if (!g) return '';
  if (g.launchd && g.launchd.keepAlive) {
    return '它由 macOS 的 launchd 托管（任务 ' + g.launchd.label + '，KeepAlive 开着），杀掉会被立刻重新拉起';
  }
  if (g.launchd) {
    return '它由 macOS 的 launchd 托管（任务 ' + g.launchd.label + '）';
  }
  if (g.pm2) return '它由 pm2 托管，杀掉会被 pm2 重新拉起';
  return '';
}

// 教用户怎么真正停掉它（平台管不了的部分）
function unloadHint(g) {
  if (!g) return '';
  if (g.launchd) {
    return 'launchctl unload ' + (g.launchd.plist || g.launchd.label);
  }
  if (g.pm2) return 'pm2 stop <应用名>';
  return '';
}

module.exports = { detect, describe, unloadHint, launchdLabelOf, plistPathFor };
