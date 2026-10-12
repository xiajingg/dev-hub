'use strict';

// Cloudflare Tunnel 集成：把本地项目的端口映射成公网域名。
//
// 能力分三档，取决于本机的实际状态：
//
//   ① 没装 cloudflared        → 只提示去官网（不引导安装，用户自己决定）
//   ② 装了但没执行过 login    → 提示先 `cloudflared tunnel login`（这一步是浏览器授权，
//                              必须用户自己点，平台代劳不了）
//   ③ 已登录（有 cert.pem）   → 读 config.yml 的 ingress 显示「端口 → 域名」映射；
//                              支持创建新 tunnel 并绑定域名
//
// ★ 关于 cert.pem：它是**账号级凭据**，能列出/创建/删除该账号下所有 tunnel。
//   平台只判断它存不存在，绝不读取内容。
//
// ★ 关于 token 模式：如果用户是在 Cloudflare 后台建的 tunnel（用 `tunnel run --token-file`
//   那种），配置在后台、本地只有个 token 文件，**本地拿不到映射关系**。
//   那种情况这里查不到，属于正常。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec } = require('./exec');

const HOME = os.homedir();

// cloudflared 自己找 cert.pem 的路径顺序（与它的报错信息保持一致）
const CERT_CANDIDATES = [
  path.join(HOME, '.cloudflared', 'cert.pem'),
  path.join(HOME, '.cloudflare-warp', 'cert.pem'),
  path.join(HOME, 'cloudflare-warp', 'cert.pem'),
  '/etc/cloudflared/cert.pem',
  '/usr/local/etc/cloudflared/cert.pem',
];

const CONFIG_CANDIDATES = [
  path.join(HOME, '.cloudflared', 'config.yml'),
  path.join(HOME, '.cloudflared', 'config.yaml'),
];

const INSTALL_URL = 'https://www.cloudflare.com/';
const LOGIN_HINT = 'cloudflared tunnel login';

function firstExisting(list) {
  for (const p of list) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {
      /* ignore */
    }
  }
  return null;
}

// ---------------------------------------------------------------- 检测

async function detect() {
  const which = await exec('/usr/bin/which', ['cloudflared']);
  const bin = which.ok && which.stdout.trim() ? which.stdout.trim() : null;

  let version = null;
  if (bin) {
    const v = await exec(bin, ['--version']);
    if (v.ok) {
      // 输出形如 "cloudflared version 2026.9.3 (built 2026-09-24T15:31:10Z)"，只要版本号
      version = String(v.stdout.trim().split('\n')[0] || '').replace(/^cloudflared version\s*/, '').split(' ')[0] || null;
    }
  }

  const certPath = firstExisting(CERT_CANDIDATES);
  const configPath = firstExisting(CONFIG_CANDIDATES);

  return {
    installed: !!bin,
    bin,
    version,
    loggedIn: !!certPath,
    certPath,
    configPath,
    home: path.join(HOME, '.cloudflared'),
    installUrl: INSTALL_URL,
    loginHint: LOGIN_HINT,
    // 给界面直接用的一句话状态
    state: !bin ? 'not-installed' : !certPath ? 'not-logged-in' : 'ready',
  };
}

// ---------------------------------------------------------------- config.yml 解析

function unquote(s) {
  const t = String(s == null ? '' : s).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

// 极简 ingress 解析。
//
// 不引 yaml 依赖（整个项目零依赖），只认这里需要的两个键：
//   ingress:
//     - hostname: app.example.com
//       service: http://localhost:5173
//     - service: http_status:404        ← 兜底规则，没有 hostname
//
// 够用且不会因为 YAML 的其它特性出错 —— 解析不了的条目直接跳过，不会误判。
function parseIngress(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  let inIngress = false;
  let cur = null;

  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, '');
    if (/^\s*ingress\s*:/.test(line)) {
      inIngress = true;
      continue;
    }
    if (!inIngress) continue;
    // 回到顶层的其它键 → ingress 段结束
    if (line.trim() && /^\S/.test(line)) break;

    const item = /^\s*-\s*(.*)$/.exec(line);
    if (item) {
      if (cur) out.push(cur);
      cur = {};
      const kv = /^([\w.-]+)\s*:\s*(.*)$/.exec(item[1].trim());
      if (kv) cur[kv[1]] = unquote(kv[2]);
      continue;
    }
    const kv = /^\s+([\w.-]+)\s*:\s*(.*)$/.exec(line);
    if (kv && cur) cur[kv[1]] = unquote(kv[2]);
  }
  if (cur) out.push(cur);
  return out.filter((x) => x.hostname || x.service);
}

// 从 service 里取出本地端口。只认 http(s)://host:port 这种，其余（http_status:404 等）返回 null。
function portOfService(service) {
  const s = String(service || '');
  if (!/^https?:\/\//i.test(s)) return null;
  const m = /:(\d+)\s*$/.exec(s);
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------- 端口 → 域名 映射

// 只读 config.yml，不调任何外部命令 —— 列表页每次刷新都要用，必须够快。
function mappingsFromConfig() {
  const configPath = firstExisting(CONFIG_CANDIDATES);
  const byPort = {};
  const entries = [];
  if (!configPath) return { configPath: null, byPort, entries };

  let text = '';
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch (_) {
    return { configPath, byPort, entries };
  }

  const tunnel = (/(?:^|\n)\s*tunnel\s*:\s*(\S+)/.exec(text) || [])[1] || '';

  for (const rule of parseIngress(text)) {
    const port = portOfService(rule.service);
    if (!rule.hostname || !port) continue;
    const e = {
      hostname: rule.hostname,
      port,
      service: rule.service,
      tunnel: unquote(tunnel),
      url: 'https://' + rule.hostname,
    };
    entries.push(e);
    if (!byPort[port]) byPort[port] = [];
    byPort[port].push(e);
  }

  return { configPath, byPort, entries };
}

// 带环境信息的完整版（要调 which / --version，慢一些，给「Cloudflare 面板」用）
async function mappings() {
  const info = await detect();
  return Object.assign(info, mappingsFromConfig());
}

// ---------------------------------------------------------------- tunnel 列表

async function listTunnels() {
  const info = await detect();
  if (!info.installed) return { ok: false, reason: 'not-installed', tunnels: [], info };
  if (!info.loggedIn) return { ok: false, reason: 'not-logged-in', tunnels: [], info };

  const r = await exec(info.bin, ['tunnel', 'list', '--output', 'json'], { timeout: 25000 });
  if (!r.ok) {
    return { ok: false, reason: 'error', error: String(r.stderr || '').trim().slice(0, 300), tunnels: [], info };
  }
  try {
    const arr = JSON.parse(r.stdout || '[]');
    return {
      ok: true,
      info,
      tunnels: (Array.isArray(arr) ? arr : []).map((t) => ({
        id: t.id || '',
        name: t.name || '',
        createdAt: t.createdAt || '',
        connections: (t.connections || []).length,
      })),
    };
  } catch (e) {
    return { ok: false, reason: 'parse', error: e.message, tunnels: [], info };
  }
}

// ---------------------------------------------------------------- 创建

// tunnel 名字要合法：cloudflared 只接受字母数字和 - _
function sanitizeName(s) {
  return String(s || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'dev-hub-tunnel';
}

function validHostname(s) {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(String(s || ''));
}

// 往 config.yml 的 ingress 段插入一条规则。
// 位置放在最后一条规则**之前** —— 那条通常是 `- service: http_status:404` 兜底，
// 新规则必须排在它前面才有机会命中。
function insertIngress(text, hostname, port) {
  const body = String(text || '');
  const lines = body.split('\n');
  const idx = lines.findIndex((l) => /^\s*ingress\s*:/.test(l));

  // 探测现有条目的缩进，保持风格一致 —— YAML 对同层级缩进的一致性有要求，
  // 硬写两空格在用户用了别的缩进时会把文件搞坏。
  let indent = '  ';
  if (idx >= 0) {
    for (let i = idx + 1; i < lines.length; i++) {
      const m = /^(\s*)-\s/.exec(lines[i]);
      if (m) {
        indent = m[1];
        break;
      }
      if (lines[i].trim() && /^\S/.test(lines[i])) break;
    }
  }

  const block = [indent + '- hostname: ' + hostname, indent + '  service: http://localhost:' + port];

  if (idx < 0) {
    const head = body.trim() ? body.replace(/\s*$/, '') + '\n' : '';
    return head + 'ingress:\n' + block.join('\n') + '\n  - service: http_status:404\n';
  }

  let lastItem = -1;
  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() && /^\S/.test(l)) break; // 段结束
    if (/^\s*-\s/.test(l)) lastItem = i;
  }
  if (lastItem >= 0) lines.splice(lastItem, 0, ...block);
  else lines.splice(idx + 1, 0, ...block);
  return lines.join('\n');
}

async function createTunnel(opts) {
  const o = opts || {};
  const info = await detect();

  if (!info.installed) {
    return {
      error: '本机没有安装 cloudflared，没法创建 tunnel',
      code: 400,
      needInstall: true,
      installUrl: INSTALL_URL,
    };
  }
  if (!info.loggedIn) {
    return {
      error: 'cloudflared 还没登录。请在终端执行 `' + LOGIN_HINT + '` 完成浏览器授权（这一步必须你本人点，平台代劳不了），然后回来重试',
      code: 400,
      needLogin: true,
      loginHint: LOGIN_HINT,
    };
  }

  const prefix = String(o.prefix || '').trim().toLowerCase();
  const domain = String(o.domain || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  const port = Number(o.port);
  const name = sanitizeName(o.name || prefix);

  if (!prefix) return { error: '请填写域名前缀', code: 400 };
  if (!domain) return { error: '请填写域名（例如 example.com）', code: 400 };
  if (!validHostname(prefix + '.' + domain)) {
    return { error: '域名格式不对：' + prefix + '.' + domain, code: 400 };
  }
  if (!port) return { error: '这个项目还没有端口，先钉一个端口再绑定域名', code: 400 };

  const hostname = prefix + '.' + domain;
  const steps = [];

  // ① tunnel 已存在就复用，避免重复创建报错
  const listed = await listTunnels();
  const existing = listed.ok ? listed.tunnels.find((t) => t.name === name) : null;

  if (!existing) {
    const c = await exec(info.bin, ['tunnel', 'create', name], { timeout: 60000 });
    if (!c.ok) {
      return { error: '创建 tunnel 失败：' + String(c.stderr || c.stdout || '').trim().slice(0, 400), code: 500, steps };
    }
    const m = /id\s+([0-9a-fA-F-]{36})/.exec(c.stdout + '\n' + c.stderr);
    steps.push({ step: 'create', ok: true, detail: '已创建 tunnel ' + name + (m ? '（' + m[1] + '）' : '') });
  } else {
    steps.push({ step: 'create', ok: true, reused: true, detail: 'tunnel ' + name + ' 已存在，直接复用' });
  }

  // ② 绑 DNS
  const d = await exec(info.bin, ['tunnel', 'route', 'dns', name, hostname], { timeout: 60000 });
  if (!d.ok) {
    return {
      error: '添加 DNS 记录失败：' + String(d.stderr || d.stdout || '').trim().slice(0, 400),
      code: 500,
      steps,
      hint: 'tunnel 已经建好了，但域名没绑上。可以在 Cloudflare 后台手动加一条指向它的 CNAME。',
    };
  }
  steps.push({ step: 'dns', ok: true, detail: '已把 ' + hostname + ' 指向该 tunnel' });

  // ③ 写 config.yml（先备份）
  const configPath = info.configPath || path.join(info.home, 'config.yml');
  let backup = null;
  try {
    if (!fs.existsSync(info.home)) fs.mkdirSync(info.home, { recursive: true });
    let text = '';
    if (fs.existsSync(configPath)) {
      text = fs.readFileSync(configPath, 'utf8');
      backup = configPath + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(configPath, backup);
    } else {
      text = 'tunnel: ' + name + '\ncredentials-file: ' + path.join(info.home, name + '.json') + '\n';
    }
    fs.writeFileSync(configPath, insertIngress(text, hostname, port), 'utf8');
    steps.push({ step: 'config', ok: true, detail: '已写入 ' + configPath + (backup ? '（原文件备份在 ' + backup + '）' : '') });
  } catch (e) {
    return {
      error: '写 config.yml 失败：' + e.message,
      code: 500,
      steps,
      hint: 'tunnel 和 DNS 都已就绪，只是本地配置没写上。手工加一条 ingress 即可。',
    };
  }

  return {
    ok: true,
    hostname,
    url: 'https://' + hostname,
    tunnel: name,
    configPath,
    backup,
    steps,
    nextSteps: [
      '运行 tunnel：cloudflared tunnel run ' + name,
      '想开机自启：sudo cloudflared service install',
    ],
  };
}

module.exports = {
  detect,
  mappings,
  mappingsFromConfig,
  listTunnels,
  createTunnel,
  // 下面几个是纯函数，导出给测试用
  parseIngress,
  portOfService,
  insertIngress,
};
