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
const store = require('./store');

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

// ================================================================ API Token 模式
//
// 上面那一套是「本地模式」：读 ~/.cloudflared/config.yml、调 cloudflared 命令。
// 它有个硬限制 —— **token 模式的 tunnel 读不到**（配置存在 Cloudflare 后台，本地没有副本）。
//
// 下面这一套是「远程模式」：用户配一个 API Token，平台直接调 Cloudflare API。
// 好处是：连已经在跑的 token 模式 tunnel 也能读到配置；不用本地登录、不用写用户的 config.yml。
//
// ★ Token 存在数据目录里（data/ 已被 .gitignore 排除），权限 600。
//   它比 cert.pem 权限窄 —— 只给「Cloudflare Tunnel: Read/Edit」就够，碰不到别的资源。

function credPath() {
  return path.join(store.DATA_DIR, 'cloudflare.json');
}

function loadCredentials() {
  try {
    const j = JSON.parse(fs.readFileSync(credPath(), 'utf8'));
    if (!j || !j.apiToken) return null;
    return {
      apiToken: String(j.apiToken),
      accountId: String(j.accountId || '').trim(),
      zone: String(j.zone || '').trim().replace(/^\.+|\.+$/g, ''),
    };
  } catch (_) {
    return null;
  }
}

function saveCredentials(input) {
  const apiToken = String((input && input.apiToken) || '').trim();
  if (!apiToken) return { error: 'API Token 不能为空', code: 400 };

  const data = {
    apiToken,
    accountId: String((input && input.accountId) || '').trim(),
    zone: String((input && input.zone) || '').trim().replace(/^\.+|\.+$/g, ''),
  };
  try {
    fs.mkdirSync(store.DATA_DIR, { recursive: true });
    const file = credPath();
    fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
    // 文件已存在时 writeFileSync 的 mode 参数不生效，显式再 chmod 一次
    fs.chmodSync(file, 0o600);
  } catch (e) {
    return { error: '保存凭据失败：' + e.message, code: 500 };
  }
  return { ok: true, credentials: publicCredentials() };
}

function clearCredentials() {
  try {
    fs.unlinkSync(credPath());
  } catch (_) {
    /* 本来就不存在 */
  }
  return { ok: true };
}

// 给前端看的版本：绝不回显 token 本身
function publicCredentials() {
  const c = loadCredentials();
  if (!c) return { configured: false };
  return {
    configured: true,
    accountId: c.accountId,
    zone: c.zone,
    tokenHint: c.apiToken.slice(0, 6) + '…' + c.apiToken.slice(-4),
  };
}

const API_BASE = 'https://api.cloudflare.com/client/v4';

// 统一封装：Bearer 认证 + 15 秒超时 + 把 Cloudflare 的 errors[0].message 提出来
async function apiRequest(method, apiPath, body) {
  const cred = loadCredentials();
  if (!cred) return { error: '还没配置 Cloudflare API Token', code: 400, needCredentials: true };
  if (!cred.accountId) {
    return {
      error: '还缺 Account ID',
      code: 400,
      needCredentials: true,
      hint: '在 Cloudflare 后台的右侧栏能看到 Account ID。',
    };
  }

  const init = {
    method,
    headers: { Authorization: 'Bearer ' + cred.apiToken, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000),
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  let res;
  try {
    res = await fetch(API_BASE + apiPath, init);
  } catch (e) {
    const why = e && e.name === 'TimeoutError' ? '请求超时' : (e && e.message) || String(e);
    return {
      error: '连不上 Cloudflare API（' + why + '）。若本机需要代理才能访问外网，平台目前不会自动走代理。',
      code: 502,
    };
  }

  let json = null;
  try {
    json = await res.json();
  } catch (_) {
    /* 保持 null */
  }

  if (!res.ok || !json || json.success === false) {
    const first = json && Array.isArray(json.errors) ? json.errors[0] : null;
    const out = {
      error: 'Cloudflare API 报错：' + ((first && first.message) || 'HTTP ' + res.status),
      code: res.status || 502,
      apiErrors: (json && json.errors) || [],
    };
    if (res.status === 401 || res.status === 403) {
      out.needCredentials = true;
      out.hint = 'Token 无效或权限不够 —— 需要一个带 Account → Cloudflare Tunnel → Read（或 Edit）权限的 API Token。';
    }
    return out;
  }
  return { ok: true, result: json.result };
}

async function apiListTunnels() {
  const cred = loadCredentials();
  const r = await apiRequest('GET', '/accounts/' + (cred ? cred.accountId : '') + '/cfd_tunnel?is_deleted=false');
  if (r.error) return r;
  return {
    ok: true,
    tunnels: (Array.isArray(r.result) ? r.result : []).map((t) => ({
      id: t.id || '',
      name: t.name || '',
      status: t.status || '',
      createdAt: t.created_at || '',
    })),
  };
}

async function apiGetConfig(tunnelId) {
  const cred = loadCredentials();
  const r = await apiRequest(
    'GET',
    '/accounts/' + (cred ? cred.accountId : '') + '/cfd_tunnel/' + tunnelId + '/configurations'
  );
  if (r.error) return r;
  const cfg = (r.result && r.result.config) || {};
  return { ok: true, ingress: Array.isArray(cfg.ingress) ? cfg.ingress : [] };
}

async function apiPutConfig(tunnelId, ingress) {
  const cred = loadCredentials();
  return apiRequest(
    'PUT',
    '/accounts/' + (cred ? cred.accountId : '') + '/cfd_tunnel/' + tunnelId + '/configurations',
    { config: { ingress } }
  );
}

async function apiCreateTunnel(name) {
  const cred = loadCredentials();
  const r = await apiRequest('POST', '/accounts/' + (cred ? cred.accountId : '') + '/cfd_tunnel', {
    name,
    // cloudflare = 配置存后台（远程管理），跟用户现有的 tunnel 一致
    config_src: 'cloudflare',
  });
  if (r.error) return r;
  return { ok: true, tunnel: { id: r.result.id, name: r.result.name, token: r.result.token || '' } };
}

async function apiZoneId(domain) {
  const r = await apiRequest('GET', '/zones?name=' + encodeURIComponent(domain));
  if (r.error) return r;
  const hit = (Array.isArray(r.result) ? r.result : [])[0];
  if (!hit) return { error: '账号下找不到域名 ' + domain, code: 404 };
  return { ok: true, zoneId: hit.id, zoneName: hit.name };
}

async function apiUpsertDns(zoneId, hostname, tunnelId) {
  const target = tunnelId + '.cfargotunnel.com';
  const list = await apiRequest(
    'GET',
    '/zones/' + zoneId + '/dns_records?type=CNAME&name=' + encodeURIComponent(hostname)
  );
  if (list.error) return list;

  const existing = (Array.isArray(list.result) ? list.result : [])[0];
  const payload = { type: 'CNAME', name: hostname, content: target, proxied: true, ttl: 1 };

  if (existing) {
    if (existing.content === target) return { ok: true, unchanged: true, id: existing.id };
    const r = await apiRequest('PUT', '/zones/' + zoneId + '/dns_records/' + existing.id, payload);
    if (r.error) return r;
    return { ok: true, updated: true, id: r.result.id };
  }
  const r = await apiRequest('POST', '/zones/' + zoneId + '/dns_records', payload);
  if (r.error) return r;
  return { ok: true, created: true, id: r.result.id };
}

// 汇总账号下所有 tunnel 的 ingress → 端口映射。
// 这是「自动同步」的核心：不管 tunnel 是本地模式还是远程模式建的，都读得到。
async function syncViaApi() {
  const listed = await apiListTunnels();
  if (listed.error) return listed;

  const byPort = {};
  const entries = [];
  const errors = [];

  for (const t of listed.tunnels) {
    const cfg = await apiGetConfig(t.id);
    if (cfg.error) {
      errors.push({ tunnel: t.name || t.id, error: cfg.error });
      continue;
    }
    for (const rule of cfg.ingress) {
      const port = portOfService(rule.service);
      if (!rule.hostname || !port) continue;
      const e = {
        hostname: rule.hostname,
        port,
        service: rule.service,
        tunnel: t.name || t.id,
        tunnelId: t.id,
        url: 'https://' + rule.hostname,
      };
      entries.push(e);
      if (!byPort[port]) byPort[port] = [];
      byPort[port].push(e);
    }
  }

  return { ok: true, tunnels: listed.tunnels, byPort, entries, errors };
}

// 用 API 绑定一个域名到本地端口。
// ★ 优先复用现有 tunnel —— 新造一个的话，用户还得拿新 token 再跑一个 cloudflared，
//   而他现有的那个本来就在跑，直接往上加规则最省事。
async function createViaApi(opts) {
  const o = opts || {};
  const cred = loadCredentials();
  if (!cred) return { error: '还没配置 Cloudflare API Token', code: 400, needCredentials: true };

  const prefix = String(o.prefix || '').trim().toLowerCase();
  const domain = String(o.domain || cred.zone || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  const port = Number(o.port);

  if (!prefix) return { error: '请填写域名前缀', code: 400 };
  if (!domain) return { error: '请填写域名（例如 example.com）', code: 400 };
  if (!validHostname(prefix + '.' + domain)) return { error: '域名格式不对：' + prefix + '.' + domain, code: 400 };
  if (!port) return { error: '这个项目还没有端口，先钉一个端口再绑定域名', code: 400 };

  const hostname = prefix + '.' + domain;
  const steps = [];

  // ① 选 tunnel：优先复用现有的，没有才新建
  const listed = await apiListTunnels();
  if (listed.error) return listed;

  let tunnel = listed.tunnels[0] || null;
  if (tunnel) {
    steps.push({ step: 'tunnel', ok: true, reused: true, detail: '复用现有 tunnel ' + (tunnel.name || tunnel.id) });
  } else {
    const created = await apiCreateTunnel(sanitizeName(o.name || 'dev-hub'));
    if (created.error) return Object.assign(created, { steps });
    tunnel = created.tunnel;
    steps.push({
      step: 'tunnel',
      ok: true,
      created: true,
      detail: '新建 tunnel ' + tunnel.name,
      nextSteps: ['这个 tunnel 还没在跑，需要用它的 token 启动：cloudflared tunnel run --token <token>'],
    });
  }

  // ② 读现有 ingress，追加新规则再整体写回（PUT 是覆盖式的，不能只发新规则）
  const cfg = await apiGetConfig(tunnel.id);
  if (cfg.error) return Object.assign(cfg, { steps });

  const rules = cfg.ingress.filter((r) => r.hostname !== hostname);
  const fallback = rules.filter((r) => !r.hostname);
  const normal = rules.filter((r) => r.hostname);
  normal.push({ hostname, service: 'http://localhost:' + port });
  const next = normal.concat(fallback.length ? fallback : [{ service: 'http_status:404' }]);

  const put = await apiPutConfig(tunnel.id, next);
  if (put.error) return Object.assign(put, { steps });
  steps.push({ step: 'config', ok: true, detail: '已写入 ingress：' + hostname + ' → http://localhost:' + port });

  // ③ 建 DNS
  const zone = await apiZoneId(domain);
  if (zone.error) return Object.assign(zone, { steps });
  const dns = await apiUpsertDns(zone.zoneId, hostname, tunnel.id);
  if (dns.error) return Object.assign(dns, { steps });
  steps.push({
    step: 'dns',
    ok: true,
    detail: (dns.created ? '已创建' : dns.updated ? '已更新' : '已存在，未改动') +
      ' CNAME ' + hostname + ' → ' + tunnel.id + '.cfargotunnel.com',
  });

  return {
    ok: true,
    hostname,
    url: 'https://' + hostname,
    tunnel: tunnel.name || tunnel.id,
    steps,
    // 配置是存在后台的，生效不需要重启 cloudflared
    note: '配置已同步到 Cloudflare，正在运行的 tunnel 会自动生效，不用重启。',
  };
}

module.exports = {
  detect,
  mappings,
  mappingsFromConfig,
  listTunnels,
  createTunnel,
  // 凭据
  loadCredentials,
  saveCredentials,
  clearCredentials,
  publicCredentials,
  // 远程模式
  apiListTunnels,
  apiGetConfig,
  apiPutConfig,
  apiCreateTunnel,
  apiZoneId,
  apiUpsertDns,
  syncViaApi,
  createViaApi,
  // 下面几个是纯函数，导出给测试用
  parseIngress,
  portOfService,
  insertIngress,
};
