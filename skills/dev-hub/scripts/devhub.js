#!/usr/bin/env node
'use strict';

// dev-hub 命令行客户端 —— 给 AI / 脚本用，不用手搓 curl。
// 平台默认在 http://127.0.0.1:4321，用 DEVHUB_URL 覆盖。

const BASE = (process.env.DEVHUB_URL || 'http://127.0.0.1:4321').replace(/\/$/, '');

async function api(path, opts) {
  let res;
  try {
    res = await fetch(BASE + path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
  } catch (err) {
    console.error('连不上 dev-hub（' + BASE + '）。');
    console.error('请先启动平台：  cd ~/Documents/dev-hub && ./start.sh');
    process.exit(2);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || 'HTTP ' + res.status);
    e.data = data;
    throw e;
  }
  return data;
}

async function allProjects() {
  return (await api('/api/projects')).projects || [];
}

// 支持用 id、完整名字、或名字的一部分来定位项目
async function findProject(ref) {
  if (!ref) {
    console.error('要指定项目。先跑：devhub list');
    process.exit(1);
  }
  const projects = await allProjects();
  const p =
    projects.find((x) => x.id === ref) ||
    projects.find((x) => x.name === ref) ||
    projects.find((x) => x.name.toLowerCase().includes(String(ref).toLowerCase()));
  if (!p) {
    console.error('找不到项目：' + ref);
    if (projects.length) console.error('现有项目：' + projects.map((x) => x.name).join('、'));
    else console.error('登记表是空的。');
    process.exit(1);
  }
  return p;
}

function fmtPort(p) {
  if (!p.port) return '-';
  return p.host === '::1' ? '[::1]:' + p.port : String(p.port);
}

function fmtMem(bytes) {
  if (!bytes) return '-';
  const mb = bytes / 1048576;
  return mb >= 1024 ? (mb / 1024).toFixed(1) + 'GB' : Math.round(mb) + 'MB';
}

const STATUS = { running: '运行中', stopped: '已停止', error: '异常退出' };

function cmdList() {
  return allProjects().then((projects) => {
    if (!projects.length) {
      console.log('登记表是空的。用 `devhub add "<命令>"` 添加，或 `devhub scan` 看看有哪些在跑。');
      return;
    }
    console.log('共 ' + projects.length + ' 个项目：\n');
    for (const p of projects) {
      let state = STATUS[p.status] || p.status;
      if (p.status !== 'running' && p.external) state = '外部运行中';
      if (p.status !== 'running' && p.orphan) state = '残留占用';
      const tags = [];
      // 来源明说 —— 别让 AI 靠「有没有标记」去猜
      if (p.status === 'running') tags.push(p.adopted ? '外部启动' : '平台启动');
      if (p.portStale) tags.push('端口已变');
      if (p.stopCommand) tags.push('自定义停止');
      console.log(
        '  ' +
          String(p.name).padEnd(18) +
          String(state).padEnd(12) +
          String(fmtPort(p)).padEnd(16) +
          'pid=' + String(p.pid || '-').padEnd(9) +
          'mem=' + String(fmtMem(p.memory)).padEnd(8) +
          (tags.length ? '[' + tags.join(',') + '] ' : '') +
          '\n    id=' + p.id + '  cwd=' + p.cwd +
          (p.livePorts && p.livePorts.length ? '\n    监听端口=' + p.livePorts.join(', ') : '')
      );
    }
  });
}

async function cmdStart(ref) {
  const p = await findProject(ref);
  const r = await api('/api/projects/' + p.id + '/start', { method: 'POST' });
  if (r.adopted) console.log('已接管：' + (r.message || p.name) + '（pid ' + r.pid + '）');
  else console.log('已启动：' + p.name + '（pid ' + r.pid + '）');
  (r.warnings || []).forEach((w) => console.log('注意：' + w));
}

async function cmdStop(ref) {
  const p = await findProject(ref);
  const r = await api('/api/projects/' + p.id + '/stop', { method: 'POST' });
  if (r.alreadyStopped) console.log(p.name + ' 本来就没在跑。');
  else {
    const how = r.via === 'script' ? '（按停止命令）' : r.via === 'script+kill' ? '（停止命令 + 强制）' : '';
    console.log('已停止：' + p.name + how);
  }
  if (r.warning) console.log('注意：' + r.warning);
}

async function cmdRestart(ref) {
  const p = await findProject(ref);
  const r = await api('/api/projects/' + p.id + '/restart', { method: 'POST' });
  console.log('已重启：' + p.name + (r.pid ? '（pid ' + r.pid + '）' : ''));
  (r.warnings || []).forEach((w) => console.log('注意：' + w));
}

// 一次性把日志拉完（内部按 offset 分块），默认只打印尾部
async function cmdLogs(ref, tailLines) {
  const p = await findProject(ref);
  const tail = Number(tailLines) || 80;
  let offset = 0;
  let text = '';
  for (let i = 0; i < 40; i++) {
    const d = await api('/api/projects/' + p.id + '/logs?offset=' + offset);
    if (d.exists === false) {
      console.log('日志文件还不存在：' + (d.file || ''));
      return;
    }
    text += d.data;
    if (d.offset === offset) break; // 没有新内容了
    offset = d.offset;
    if (text.length > 512 * 1024) break;
  }
  const lines = text.split('\n');
  const shown = lines.slice(-tail);
  console.log('--- ' + p.name + ' 日志（末 ' + Math.min(tail, lines.length) + ' 行 / 共 ' + lines.length + ' 行）---');
  console.log('文件：' + p.logPath + (p.logSource === 'external' ? '（项目自己的日志文件）' : ''));
  console.log(shown.join('\n'));
}

async function cmdAdd(command, flags) {
  if (!command) {
    console.error('要给出启动命令。命令必须自带 cd 绝对路径，例如：');
    console.error('  devhub add "cd ~/projects/my-app && npm run dev"');
    process.exit(1);
  }
  const body = { command };
  if (flags.name) body.name = flags.name;
  if (flags.port) body.port = Number(flags.port);
  if (flags.host) body.host = flags.host;
  if (flags.stop) body.stopCommand = flags.stop;
  if (flags.log) body.logFile = flags.log;
  const r = await api('/api/projects', { method: 'POST', body: JSON.stringify(body) });
  console.log('已登记：' + r.project.name + '（id ' + r.project.id + '）');
  console.log('  命令：' + r.project.command);
  console.log('  目录：' + r.project.cwd);
  if (r.project.port) console.log('  认领：' + (r.project.host || '*') + ':' + r.project.port);
  (r.warnings || []).forEach((w) => console.log('注意：' + w));
}

async function cmdScan() {
  const { candidates } = await api('/api/scan', { method: 'POST' });
  if (!candidates.length) {
    console.log('没扫到属于你的项目进程。');
    return;
  }
  console.log('扫到 ' + candidates.length + ' 个候选：\n');
  for (const c of candidates) {
    console.log(
      '  ' +
        String(c.name).padEnd(18) +
        String(c.host || '*').padEnd(12) +
        '端口=' + JSON.stringify(c.ports).padEnd(30) +
        (c.duplicate ? '已登记（' + c.duplicateReason + '）' : '可导入')
    );
    console.log('    ' + c.suggestedCommand + (c.commandReliable ? '' : '   ← 命令待补全'));
  }
  console.log('\n要导入用：devhub import <名字>   （或去界面上勾选）');
}

async function cmdImport(name) {
  const { candidates } = await api('/api/scan', { method: 'POST' });
  const c = candidates.find((x) => x.name === name) || candidates.find((x) => x.name.includes(name));
  if (!c) {
    console.error('扫描结果里没有：' + name);
    process.exit(1);
  }
  const r = await api('/api/import', {
    method: 'POST',
    body: JSON.stringify({
      items: [{ name: c.name, command: c.suggestedCommand, port: c.port, host: c.host, pid: c.pid, pgid: c.pgid }],
    }),
  });
  const first = (r.results || [])[0] || {};
  if (first.ok) console.log('已导入：' + first.name + (first.adopted ? '（并已接管正在跑的进程）' : ''));
  else console.error('导入失败：' + first.error);
}

const KIND_LABEL = { service: '服务', infra: '中间件', mgmt: '管理端口', noise: 'GUI 内部' };

async function cmdPorts(cwd) {
  if (!cwd) {
    console.error('要给出目录：devhub ports ~/projects/my-app');
    process.exit(1);
  }
  const d = await api('/api/ports/by-cwd', { method: 'POST', body: JSON.stringify({ cwd }) });
  console.log('目录：' + d.cwd);
  if (!d.services.length && !d.hidden.length) {
    console.log('  没有在监听任何端口。');
    return;
  }
  if (d.services.length) {
    console.log('  服务端口（界面上默认显示的就是这些）：');
    for (const s of d.services) {
      console.log('    ' + String(s.host + ':' + s.port).padEnd(20) + String(s.cmd || '').padEnd(12) + s.url);
    }
  }
  if (d.hidden.length) {
    console.log('  已折叠的端口：');
    for (const s of d.hidden) {
      console.log(
        '    ' + String(s.host + ':' + s.port).padEnd(20) + String(s.cmd || '').padEnd(12) + (KIND_LABEL[s.kind] || '')
      );
    }
    console.log('  （端口号 >= 10000 的默认折叠 —— 多是 JMX / 监控 / 系统临时端口；真要当主端口用，可以在界面上钉住）');
  }
}

async function cmdParse(command) {
  const r = await api('/api/cmd/parse', { method: 'POST', body: JSON.stringify({ command }) });
  console.log(JSON.stringify(r, null, 2));
}

function parseFlags(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') flags.name = argv[++i];
    else if (a === '--port') flags.port = argv[++i];
    else if (a === '--host') flags.host = argv[++i];
    else if (a === '--stop') flags.stop = argv[++i];
    else if (a === '--log') flags.log = argv[++i];
    else rest.push(a);
  }
  return { flags, rest };
}

const USAGE = `dev-hub 命令行客户端

  devhub list                        列出所有项目及状态
  devhub start   <项目>              启动（若已在跑则直接接管）
  devhub stop    <项目>              停止（有停止命令就先执行它）
  devhub restart <项目>              重启
  devhub logs    <项目> [行数]       打印日志尾部（默认 80 行）
  devhub add     "<命令>" [选项]     登记新项目
         --name <名字> --port <端口> --host <地址> --stop "<停止命令>" --log <日志文件>
  devhub scan                        扫描当前在跑的服务
  devhub import  <名字>              把扫描到的某个服务导入
  devhub ports   <目录>              查某目录下在监听的服务端口
  devhub parse   "<命令>"            只解析命令里的 cd，不登记

<项目> 可以是 id、完整名字、或名字的一部分。
环境变量 DEVHUB_URL 可改平台地址（默认 http://127.0.0.1:4321）。`;

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  const { flags, rest } = parseFlags(argv);

  switch (cmd) {
    case 'list':
    case 'ls':
      return cmdList();
    case 'start':
      return cmdStart(rest[0]);
    case 'stop':
      return cmdStop(rest[0]);
    case 'restart':
      return cmdRestart(rest[0]);
    case 'logs':
    case 'log':
      return cmdLogs(rest[0], rest[1]);
    case 'add':
      return cmdAdd(rest[0], flags);
    case 'scan':
      return cmdScan();
    case 'import':
      return cmdImport(rest[0]);
    case 'ports':
      return cmdPorts(rest[0]);
    case 'parse':
      return cmdParse(rest[0]);
    case 'help':
    case '-h':
    case '--help':
    case undefined:
      console.log(USAGE);
      return;
    default:
      console.error('不认识的命令：' + cmd + '\n');
      console.log(USAGE);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('失败：' + err.message);
  process.exit(1);
});
