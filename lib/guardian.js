'use strict';

// 守护进程探测：找出「杀不死」的进程背后是谁在保活。
//
// 为什么要这个：
//   进程被 launchd（KeepAlive）或 pm2 托管时，杀掉它会被**立刻重新拉起**。
//   在平台上的表现是「点停止 → 显示已停止 → 端口马上又被占」，而且永远接管不到它
//   （每次点启动都只能接管，来源永远标「外部启动」）。不告诉用户原因，这就是玄学。
//
// ★ 判据为什么是「扫 plist 文件」而不是 `launchctl list`：
//   实测 `launchctl list` **会间歇性失败** —— 同一台机器上，几分钟前还能列出全部任务，
//   之后就连 shell 里直接跑都返回 exit=1、零输出（沙箱 / mach 服务权限相关）。
//   而 plist 是磁盘上的静态文件，读它不需要任何特权，永远拿得到。
//   所以主判据是「扫 plist + 匹配进程」，launchctl 只在可用时作为补充确认。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('./exec');

const LAUNCHD_DIRS = [
  path.join(os.homedir(), 'Library', 'LaunchAgents'),
  '/Library/LaunchAgents',
  '/Library/LaunchDaemons',
];

// ---------------------------------------------------------------- plist 解析

function xmlString(txt, key) {
  const m = new RegExp('<key>\\s*' + key + '\\s*</key>\\s*<string>([\\s\\S]*?)</string>').exec(txt);
  if (!m) return null;
  return m[1]
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function xmlArray(txt, key) {
  const block = new RegExp('<key>\\s*' + key + '\\s*</key>\\s*<array>([\\s\\S]*?)</array>').exec(txt);
  if (!block) return [];
  const out = [];
  const re = /<string>([\s\S]*?)<\/string>/g;
  let m;
  while ((m = re.exec(block[1]))) out.push(xmlString('<key>x</key><string>' + m[1] + '</string>', 'x'));
  return out;
}

// KeepAlive 有三种写法，必须都认：
//   <true/>   → 无条件保活，杀掉必拉起
//   <false/>  → 不保活
//   <dict>    → 条件保活（Crashed / SuccessfulExit 等），被强杀时仍会重启
function parseKeepAlive(txt) {
  const m = /<key>\s*KeepAlive\s*<\/key>\s*(<true\/>|<false\/>|<dict>[\s\S]*?<\/dict>)/i.exec(txt);
  if (!m) return { keepAlive: false, keepAliveMode: 'none' };
  const block = m[1];
  if (/^<true\/>$/i.test(block)) return { keepAlive: true, keepAliveMode: 'always' };
  if (/^<false\/>$/i.test(block)) return { keepAlive: false, keepAliveMode: 'none' };
  // dict：只要带了 Crashed=true 或 SuccessfulExit=false，被信号杀死后就会被拉起
  const crashed = /<key>\s*Crashed\s*<\/key>\s*<true\/>/i.test(block);
  const notSuccessful = /<key>\s*SuccessfulExit\s*<\/key>\s*<false\/>/i.test(block);
  return { keepAlive: crashed || notSuccessful, keepAliveMode: 'conditional' };
}

function loadLaunchdJobs() {
  const jobs = [];
  for (const dir of LAUNCHD_DIRS) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (_) {
      continue; // 目录不存在或不可读，正常
    }
    for (const n of names) {
      if (!n.endsWith('.plist')) continue;
      const plist = path.join(dir, n);
      let raw;
      try {
        raw = fs.readFileSync(plist, 'utf8');
      } catch (_) {
        continue;
      }
      // ★ 先剥掉 XML 注释 —— 注释里可能出现 <key>KeepAlive</key> 之类的字样，会干扰解析
      const txt = raw.replace(/<!--[\s\S]*?-->/g, '');
      const label = xmlString(txt, 'Label') || n.replace(/\.plist$/, '');
      const args = xmlArray(txt, 'ProgramArguments');
      const program = xmlString(txt, 'Program');
      if (!args.length && program) args.push(program);
      const ka = parseKeepAlive(txt);
      jobs.push({
        label,
        plist,
        args,
        keepAlive: ka.keepAlive,
        keepAliveMode: ka.keepAliveMode,
        runAtLoad: /<key>\s*RunAtLoad\s*<\/key>\s*<true\/>/i.test(txt),
        workingDir: xmlString(txt, 'WorkingDirectory'),
        stdoutPath: xmlString(txt, 'StandardOutPath'),
      });
    }
  }
  return jobs;
}

// ---------------------------------------------------------------- 进程匹配

// 进程的命令行是否就是这个 launchd 任务在跑的东西。
// 用「plist 里的参数全部出现在命令行里」做匹配 —— 参数路径都是绝对路径，很不容易误判。
function argsMatch(cmd, args) {
  if (!cmd || !args || !args.length) return false;
  if (args.length === 1) return cmd.trim().startsWith(args[0]); // 单个参数要求从头匹配
  return args.every((a) => cmd.includes(a));
}

// 向上遍历父进程链（最多 8 层）。nginx 这类由启动脚本拉起的服务，
// 自己命令行里看不出 launchd，得往上找到那个被 launchd 直接执行的脚本。
async function ancestry(pid, maxDepth) {
  const chain = [];
  let cur = Number(pid);
  for (let i = 0; i < (maxDepth || 8) && cur && cur > 1; i++) {
    const r = await exec('/bin/ps', ['-o', 'ppid=,command=', '-p', String(cur)]);
    if (!r.ok) break;
    const m = /^(\d+)\s+([\s\S]*)$/.exec(r.stdout.trim());
    if (!m) break;
    chain.push({ pid: cur, cmd: m[2] });
    cur = Number(m[1]);
  }
  return chain;
}

// 进程的 stdout 指向哪个文件（lsof 的 fd 1）
async function stdoutOf(pid) {
  const r = await exec('lsof', ['-a', '-p', String(pid), '-d', '1', '-Fn']);
  if (!r.ok && !r.stdout.trim()) return null;
  const line = r.stdout.split('\n').find((l) => l.startsWith('n'));
  return line ? line.slice(1) : null;
}

async function cwdOf(pid) {
  const r = await exec('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  if (!r.ok && !r.stdout.trim()) return null;
  const line = r.stdout.split('\n').find((l) => l.startsWith('n'));
  return line ? line.slice(1) : null;
}

// /tmp 和 /private/tmp 是同一个地方（符号链接），比较前先归一化
function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => {
    try {
      return fs.realpathSync(p);
    } catch (_) {
      return path.resolve(p);
    }
  };
  return norm(a) === norm(b);
}

// 找出这个进程是哪个 launchd 任务在跑。
//
// 三层判据，按可信度从高到低。**主判据刻意不用 ps** ——
// 实测 ps 在受限环境里会直接 EPERM，而 lsof 和读文件都正常。
async function launchdJobOf(pid) {
  const jobs = loadLaunchdJobs();
  if (!jobs.length || !pid) return null;

  // ① 强：进程的 stdout 就是这个任务的 StandardOutPath
  //    launchd 会把任务的 stdout 接在它指定的文件上，这个对应关系很难是巧合。
  //
  //    ★ 但必须排除 /dev/* —— 一堆 daemon 都把 stdio 丢进 /dev/null，
  //    拿它匹配会误判（实测 nginx 的 fd1 是 /dev/null，被错认成一个完全不相干的系统任务）。
  let fd1 = await stdoutOf(pid);
  if (fd1 && fd1.startsWith('/dev/')) fd1 = null;
  if (fd1) {
    for (const job of jobs) {
      if (job.stdoutPath && !job.stdoutPath.startsWith('/dev/') && samePath(fd1, job.stdoutPath)) {
        return Object.assign({}, job, {
          confidence: 'high',
          evidence: 'stdout 指向任务配置的输出文件 ' + job.stdoutPath,
        });
      }
    }
  }

  // ② 中：工作目录一致，且这个任务要执行的脚本就在该目录下。
  //    覆盖那些自己把 stdio 重定向掉（比如 nginx 重定向到 /dev/null）的服务。
  const cwd = await cwdOf(pid);
  if (cwd) {
    const root = path.resolve(cwd);
    for (const job of jobs) {
      if (!job.workingDir || !samePath(cwd, job.workingDir)) continue;
      // ★ 要找的是「位于这个目录下的脚本」，不能退化成「第一个存在的路径」——
      //    后者会命中 /bin/bash 这种解释器，而它显然不在项目目录里（实测就栽在这）。
      const script = job.args.find((a) => {
        if (!a.includes('/')) return false;
        const abs = path.resolve(a);
        if (abs !== root && !abs.startsWith(root + path.sep)) return false;
        return fs.existsSync(abs);
      });
      if (!script) continue;
      return Object.assign({}, job, {
        confidence: 'medium',
        evidence: '工作目录一致（' + cwd + '），且任务要跑的 ' + path.basename(script) + ' 就在这里',
      });
    }
  }

  // ③ 弱：命令行匹配。只在 ps 可用时有效，能覆盖「启动脚本还活着」的情况。
  const chain = await ancestry(pid);
  for (const node of chain) {
    for (const job of jobs) {
      if (!argsMatch(node.cmd, job.args)) continue;
      return Object.assign({}, job, {
        confidence: 'high',
        via: node.pid === Number(pid) ? 'self' : 'ancestor',
        evidence: '命令行匹配（pid ' + node.pid + '）',
      });
    }
  }
  return null;
}

// ---------------------------------------------------------------- 对外接口

async function detect(pid) {
  const out = { pid: pid || null, launchd: null, pm2: false, orphan: false };
  if (!pid) return out;

  const pp = await exec('/bin/ps', ['-o', 'ppid=', '-p', String(pid)]);
  out.orphan = parseInt(pp.stdout.trim(), 10) === 1;

  out.launchd = await launchdJobOf(pid);

  // pm2 会在被托管进程的环境里塞 PM2_HOME / pm_id
  const env = await exec('/bin/ps', ['eww', '-o', 'command=', '-p', String(pid)]);
  if (/PM2_HOME=|pm_id=/.test(env.stdout)) out.pm2 = true;

  return out;
}

// 一句话说清「为什么杀不掉」。没有守护时返回空串。
function describe(g) {
  if (!g) return '';
  if (g.launchd && g.launchd.keepAlive) {
    const j = g.launchd;
    const how =
      j.keepAliveMode === 'conditional'
        ? 'KeepAlive 是条件式（崩溃或被强杀时会重启；优雅退出不会）'
        : 'KeepAlive 开着（杀掉就会被立刻拉起）';
    const via = j.via === 'ancestor' ? '，本项目由它启动' : '';
    return '它由 macOS 的 launchd 托管（任务 ' + j.label + via + '，' + how + '）';
  }
  if (g.launchd) {
    return '它由 macOS 的 launchd 托管（任务 ' + g.launchd.label + '，没开 KeepAlive）';
  }
  if (g.pm2) return '它由 pm2 托管，杀掉会被 pm2 重新拉起';
  return '';
}

// 教用户怎么真正停掉它（平台管不了的那部分）
function unloadHint(g) {
  if (!g) return '';
  if (g.launchd) return 'launchctl unload ' + g.launchd.plist;
  if (g.pm2) return 'pm2 stop <应用名>';
  return '';
}

module.exports = { detect, describe, unloadHint, loadLaunchdJobs, launchdJobOf, ancestry };
