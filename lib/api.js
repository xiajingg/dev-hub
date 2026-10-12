'use strict';

// 业务逻辑层。server.js 只负责路由，所有实际动作都在这里。

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const cmdparse = require('./cmdparse');
const logs = require('./logs');
const proc = require('./process');
const ports = require('./ports');
const scanner = require('./scanner');
const portclass = require('./portclass');
const guardian = require('./guardian');
const { exec } = require('./exec');

// 正在被我们主动停止的项目 id —— 用于区分「用户点的停止」和「进程自己崩了」
const stopping = new Set();
const whichCache = {};

function newId() {
  return crypto.randomBytes(4).toString('hex');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ★ 唯一键是「地址 + 端口」，不是光端口号。
// 双栈下 127.0.0.1:5173 和 [::1]:5173 是两个不同的 socket，内核允许它们同时监听，
// 所以它们不算冲突；只有地址也撞上（或任一方地址未知）才拦。
function findPortClash(projects, host, port, exceptId) {
  const h = host || '';
  return (
    (projects || []).find(
      (p) => p.id !== exceptId && Number(p.port) === Number(port) && ports.hostsConflict(h, p.host || '')
    ) || null
  );
}

// 「地址:端口」的可读写法，地址未知时用 *
function portLabel(host, port) {
  return (host || '*') + ':' + port;
}

// 地址字段规范化。只认回环地址；其它一律当「未知」，走保守判定。
function normalizeHost(v) {
  const h = String(v == null ? '' : v).trim();
  if (!h) return '';
  if (h === 'localhost') return '127.0.0.1';
  if (h === '[::1]') return '::1';
  if (h === '127.0.0.1' || h === '::1') return h;
  return '';
}

function sanitizeEnv(env) {
  if (!env || typeof env !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    const key = String(k).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = String(v);
  }
  return out;
}

// 一次 lsof 拿到全平台所有项目的监听端口，避免每个项目各跑一次。
// 返回 { cwd: [{ port, scope, cmd, pid }] }，scope=all 表示对外绑定（* / 0.0.0.0）。
async function livePortMap() {
  const ls = await ports.listeners();
  if (!ls.length) return {};
  const cwds = await ports.cwdsOfPids(ls.map((x) => x.pid));
  const map = {};
  for (const l of ls) {
    const c = cwds[l.pid];
    if (!c) continue;
    if (!map[c]) map[c] = [];
    for (const addr of l.addrs) {
      const port = ports.parseAddrPort(addr);
      if (!port) continue;
      const scope = /^(\*|0\.0\.0\.0|\[::\]):/.test(addr) ? 'all' : 'local';
      const hit = map[c].find((x) => x.port === port);
      if (hit) {
        // 同一端口可能同时绑 IPv4/IPv6 各出现一次；优先记住对外绑定的那条
        if (scope === 'all') {
          hit.scope = 'all';
          hit.addr = addr;
        }
        continue;
      }
      map[c].push({
        port,
        scope,
        cmd: l.cmd,
        pid: l.pid,
        addr,
        host: ports.hostOfAddr(addr),
        bindHost: ports.bindHostOfAddr(addr),
      });
    }
  }
  for (const k of Object.keys(map)) map[k].sort((a, b) => a.port - b.port);
  return map;
}

async function buildView(project, rt, pmap) {
  const cwd = ports.normPath(project.cwd || '.');
  const entries = pmap[cwd] || [];
  const picked = portclass.pick(entries, project.port);

  // 正在监听的端口 → 生成可点击的地址，前端点一下就能直接打开项目页面。
  // GUI 应用的内部端口（Electron 那些）不是网页，排除掉。
  const portLinks = entries
    .filter((e) => portclass.classify(e) !== 'noise')
    .map((e) => {
      const host = e.host || ports.hostOfAddr(e.addr);
      return {
        port: e.port,
        host,
        bindHost: e.bindHost || ports.bindHostOfAddr(e.addr),
        url: 'http://' + host + ':' + e.port,
        cmd: e.cmd || '',
        kind: portclass.classify(e),
      };
    });
  const pid = rt && rt.pid ? rt.pid : null;
  const alive = pid ? proc.isAlive(pid) : false;

  let status = 'stopped';
  if (alive) status = 'running';
  else if (rt && rt.status === 'error') status = 'error';

  // 登记时钉的端口现在已经没人在监听了 —— 多半是服务换了端口。
  // 这会让「地址 + 端口」这个唯一键失效（导入去重认不出它），所以要在界面上标出来提醒重钉。
  const portStale = !!(project.port && entries.length && !entries.some((e) => Number(e.port) === Number(project.port)));

  // 进程不在，但端口有东西在听 —— 分两种情况，标签不同：
  //   orphan   平台启动过、进程已死但端口还被占着（残留/孤儿）
  //   external 平台没记录，但目录下有服务在跑（多半是你在终端手动起的）
  // 钉了端口的记录只认自己那个端口 —— 这样同一目录下的前后端两条记录不会互相误判。
  const hadPid = !!(rt && rt.pid);
  const busyPort = !alive && (project.port ? picked.pinnedListening : picked.anyNonNoise);
  const orphan = busyPort && hadPid;
  const external = busyPort && !hadPid;

  const logInfo = effectiveLogFile(project);

  return {
    id: project.id,
    name: project.name,
    command: project.command,
    cwd: project.cwd,
    env: project.env || {},
    tags: project.tags || [],
    stopCommand: project.stopCommand || '',
    logFile: project.logFile || '',
    logSource: logInfo.external ? 'external' : 'captured',
    logPath: logInfo.file,
    createdAt: project.createdAt,
    status,
    orphan,
    external,
    pid: alive ? pid : null,
    pgid: alive && rt ? rt.pgid : null,
    startedAt: rt ? rt.startedAt : null,
    exitCode: rt ? rt.exitCode : null,
    lastError: rt ? rt.lastError || null : null,
    adopted: rt ? !!rt.adopted : false,
    verify: rt ? rt.verify || null : null,
    host: project.host || '',
    port: picked.port,
    claimedHost: project.host || '',
    claimedPort: project.port || null,
    claimLabel: project.port ? portLabel(project.host, project.port) : '',
    portStale,
    extraPorts: picked.extra,
    livePorts: picked.all,
    hiddenPorts: picked.hidden,
    portLinks,
    memory: alive ? await proc.memoryOf({ pid, pgid: rt.pgid }) : null,
    logSize: logs.sizeOfFile(logInfo.file),
  };
}

async function listProjects() {
  const { projects } = store.loadProjects();
  const runtime = store.loadRuntime();
  const pmap = await livePortMap();
  const out = [];
  for (const p of projects) out.push(await buildView(p, runtime[p.id], pmap));
  return out;
}

// 查某个目录下当前监听的服务端口，供「编辑」时选择本记录要钉住哪个端口。
// 这是「前后端拆成两条记录」的入口：同一目录建两条，各钉一个端口。
async function portsOfCwd(cwd) {
  const target = ports.normPath(cwd || '');
  const entries = (await livePortMap())[target] || [];
  const services = [];
  const hidden = [];
  for (const e of entries) {
    const kind = portclass.classify(e);
    const item = {
      port: e.port,
      host: e.host,
      bindHost: e.bindHost,
      url: 'http://' + e.host + ':' + e.port,
      scope: e.scope,
      cmd: e.cmd,
      kind,
    };
    if (kind === 'service') services.push(item);
    else hidden.push(item);
  }
  return { cwd: target, services, hidden };
}

// ---------------------------------------------------------------- CRUD

async function createProject(body) {
  const raw = String((body && body.command) || '');
  const parsed = cmdparse.parse(raw);
  if (!parsed.ok) return { error: parsed.error, code: 400 };

  const project = {
    id: newId(),
    name: String((body && body.name) || parsed.name || '未命名').trim() || parsed.name,
    command: raw.trim(),
    cwd: parsed.cwd,
    env: sanitizeEnv(body && body.env),
    tags: Array.isArray(body && body.tags) ? body.tags.map(String) : [],
    host: normalizeHost(body && body.host),
    port: Number(body && body.port) || parsed.port || null,
    stopCommand: String((body && body.stopCommand) || '').trim(),
    logFile: String((body && body.logFile) || '').trim(),
    createdAt: new Date().toISOString(),
  };

  // 唯一键是「地址 + 端口」。校验放在写队列里做，这样同一批导入的多条也会互相去重。
  const result = await store.updateProjects((data) => {
    if (project.port) {
      const dup = findPortClash(data.projects, project.host, project.port, null);
      if (dup) return { error: portLabel(project.host, project.port) + ' 已被「' + dup.name + '」认领', dup };
    }
    data.projects.push(project);
    return { project };
  });

  if (result.error) {
    return {
      error: result.error + '（唯一键是「地址 + 端口」，一条记录只能认领一个）',
      code: 409,
      portTaken: true,
      by: result.dup && result.dup.name,
    };
  }

  return { project: result.project, warnings: parsed.exists ? [] : ['目录不存在：' + parsed.cwd] };
}

async function updateProject(id, body) {
  let error = null;
  let code = 400;

  const b = body || {};

  // ★ 必须区分「请求里没提这个字段」和「显式传了 null」，用 hasOwnProperty 判断。
  //   只看 != null 的话，前端把端口框清空后发来的 {"port": null} 会被当成「没传」，
  //   于是端口永远删不掉 —— 这正是修掉的那个 bug。
  //     port 没传     → 保持原样（顺带让新命令里解析出的端口参与）
  //     port: null    → 取消钉住，交给启动后自动探测
  const portGiven = Object.prototype.hasOwnProperty.call(b, 'port');
  const hostGiven = Object.prototype.hasOwnProperty.call(b, 'host');

  const result = await store.updateProjects((data) => {
    const p = data.projects.find((x) => x.id === id);
    if (!p) {
      error = '项目不存在';
      code = 404;
      return null;
    }

    // 先算出新值，全部校验通过再落盘 —— 避免校验失败却已经把改动写进去
    const next = {
      command: p.command,
      cwd: p.cwd,
      host: p.host || '',
      port: p.port,
      name: p.name,
      env: p.env,
      tags: p.tags,
      stopCommand: p.stopCommand || '',
      logFile: p.logFile || '',
    };

    if (b.command != null) {
      const parsed = cmdparse.parse(String(b.command));
      if (!parsed.ok) {
        error = parsed.error;
        return null;
      }
      next.command = String(b.command).trim();
      next.cwd = parsed.cwd;
      // 只有「没显式提到端口」时，命令里解析出的端口才参与
      if (!portGiven) next.port = parsed.port || next.port;
    }
    if (b.name != null) next.name = String(b.name).trim();
    if (b.env != null) next.env = sanitizeEnv(b.env);
    if (b.tags != null) next.tags = Array.isArray(b.tags) ? b.tags.map(String) : [];
    if (portGiven) {
      const n = Number(b.port);
      next.port = Number.isFinite(n) && n > 0 ? n : null;
    }
    if (hostGiven) next.host = normalizeHost(b.host);
    if (b.stopCommand != null) next.stopCommand = String(b.stopCommand).trim();
    if (b.logFile != null) next.logFile = String(b.logFile).trim();

    // 没有端口就没有地址 —— 别让上一个端口绑过的地址留在记录里
    if (!next.port) next.host = '';

    // 唯一键是「地址 + 端口」：地址也要对上才算撞
    if (next.port) {
      const dup = findPortClash(data.projects, next.host, next.port, id);
      if (dup) {
        error = portLabel(next.host, next.port) + ' 已被「' + dup.name + '」认领（唯一键是「地址 + 端口」）';
        code = 409;
        return null;
      }
    }

    Object.assign(p, next);
    return p;
  });

  if (error) return { error, code };
  return { project: result };
}

async function deleteProject(id) {
  // 只移除登记记录，**不杀进程**。
  // 理由：删除的语义是「从列表里拿掉」，不是「停服务」。尤其对于扫描导入的进程 ——
  // 那是用户自己在终端起的，平台没有资格替他杀掉。想停请先显式点「停止」。
  await store.updateProjects((data) => {
    const i = data.projects.findIndex((x) => x.id === id);
    if (i >= 0) data.projects.splice(i, 1);
    return i >= 0;
  });
  await store.updateRuntime((r) => {
    delete r[id];
  });
  return { ok: true };
}

// ---------------------------------------------------------------- 生命周期

async function hasTool(name) {
  if (name in whichCache) return whichCache[name];
  const r = await exec('/usr/bin/which', [name]);
  const ok = r.ok && !!r.stdout.trim();
  whichCache[name] = ok;
  return ok;
}

async function toolWarnings(project) {
  const warnings = [];
  const cmd = project.command || '';
  if (/(^|\s|\/)(mvn|maven)(\s|$)|spring-boot:run/.test(cmd) && !(await hasTool('mvn'))) {
    warnings.push(
      '未检测到 maven（mvn），这个项目很可能起不来。建议改用项目自带的启动脚本，例如 ./scripts/start-local.sh'
    );
  }
  if (/(^|\s|\/)gradle(\s|$)/.test(cmd) && !(await hasTool('gradle'))) {
    warnings.push('未检测到 gradle，建议改用项目自带的 ./gradlew');
  }
  if (/java|spring|mvn/.test(cmd) && !process.env.JAVA_HOME) {
    warnings.push('环境变量 JAVA_HOME 未设置，如有需要可在项目的环境变量里显式配置');
  }
  return warnings;
}

async function startProject(id) {
  const { projects } = store.loadProjects();
  const project = projects.find((x) => x.id === id);
  if (!project) return { error: '项目不存在', code: 404 };

  const runtime = store.loadRuntime();
  const rt = runtime[id];
  if (rt && rt.pid && proc.isAlive(rt.pid)) return { error: '项目已在运行中', code: 409 };

  if (!project.cwd || !fs.existsSync(project.cwd)) {
    return { error: '工作目录不存在：' + project.cwd, code: 400 };
  }

  const warnings = await toolWarnings(project);

  // 端口冲突检测。唯一键是「地址 + 端口」，所以要先看占用者绑在哪个地址 ——
  // 双栈下 127.0.0.1:5173 和 [::1]:5173 是两个不同的 socket，不该互相拦。
  // 例外：登记的端口其实是 GUI 应用（Electron 等）的内部端口时忽略（那是扫描导入误存的）。
  if (project.port) {
    const owners = (await ports.portOwners(project.port)).filter((o) => !portclass.isNoiseProc(o.cmd));
    const clash = owners.find((o) =>
      (o.addrs || []).some((addr) => ports.hostsConflict(project.host || '', ports.bindHostOfAddr(addr)))
    );
    if (clash) {
      // ★ 占用者如果就是这个目录下的服务，那它就是本项目 —— 直接接管，而不是报冲突。
      // 这是「点启动 → 发现已经在跑 → 接管」的路径，省得用户还得绕去点「扫描当前运行的服务」。
      const ownerCwds = await ports.cwdsOfPids([clash.pid]);
      const ownerCwd = ownerCwds[clash.pid];
      if (ownerCwd && ownerCwd === ports.normPath(project.cwd)) {
        const pgid = (await proc.pgidOf(clash.pid)) || null;
        const g = await guardian.detect(clash.pid);
        await store.updateRuntime((r) => {
          r[id] = {
            pid: clash.pid,
            pgid,
            status: 'running',
            startedAt: new Date().toISOString(),
            exitCode: null,
            lastError: null,
            adopted: true,
            adoptedFrom: 'start',
            logFile: logs.logPathFor(id),
          };
        });
        const why = guardian.describe(g);
        return {
          ok: true,
          adopted: true,
          pid: clash.pid,
          guardian: g,
          message:
            '端口 ' + portLabel(project.host, project.port) + ' 上已经有一个本项目的服务在跑（PID ' + clash.pid +
            '）。平台没有重新启动它，只接管了它的 PID —— 所以来源标「外部启动」',
          warning: why ? why + '。要真正停掉它：' + guardian.unloadHint(g) : '',
        };
      }

      return {
        error:
          portLabel(project.host, project.port) +
          ' 已被占用（PID ' + clash.pid + ' ' + clash.cmd + '，绑在 ' + (clash.addrs || []).join('、') +
          '，工作目录 ' + (ownerCwd || '未知') + '）',
        code: 409,
        portConflict: true,
      };
    }
    if (owners.length) {
      warnings.push(
        '端口 ' + project.port + ' 已被 ' + owners[0].cmd + ' 占用，但它绑在 ' +
        (owners[0].addrs || []).join('、') + '，与本记录不冲突，继续启动'
      );
    }
  }

  // 该目录下已经有服务在监听 → 多半是同一个服务已经在跑（只是平台没接管），提示避免重复启动。
  // 钉了端口的记录只关心「除我之外还有没有别的」，否则前后端拆两条会互相误报。
  const liveEntries = (await livePortMap())[ports.normPath(project.cwd)] || [];
  const pickedLive = portclass.pick(liveEntries, project.port);
  const others = project.port ? pickedLive.all.filter((p) => p !== project.port) : pickedLive.all;
  if (others.length) {
    warnings.push(
      '注意：该目录下已经有服务在监听端口 ' + others.join('、') +
        '，可能是同一个服务已经在跑但没被平台接管。建议先点「扫描当前运行的服务」导入接管，避免重复启动。'
    );
  }

  const res = await proc.start(project, (info) => handleExit(id, info));
  if (!res.ok) return { error: res.error || '启动失败', code: 500 };

  await store.updateRuntime((r) => {
    r[id] = {
      pid: res.pid,
      pgid: res.pgid,
      status: 'running',
      startedAt: new Date().toISOString(),
      exitCode: null,
      lastError: null,
      adopted: false,
      logFile: logs.logPathFor(id),
    };
  });

  // 异步探测真实端口并回填（不阻塞响应）。
  // 只填「还没认领端口」的记录 —— 用户钉过端口的绝不动，否则同目录拆两条会互相覆盖。
  // 认领前还要确认「地址 + 端口」都不和别人撞。
  // 绑在任意地址（*）上的不记 host（留空 = 未知），冲突判定会走保守分支。
  proc
    .detectPorts(project)
    .then(async (found) => {
      if (!found.length) return;
      await store.updateProjects((data) => {
        const t = data.projects.find((x) => x.id === id);
        if (!t || t.port) return;
        const free = found.find(
          (e) => !findPortClash(data.projects, e.bindHost === '*' ? '' : e.host, e.port, id)
        );
        if (free) {
          t.port = free.port;
          t.host = free.bindHost === '*' ? '' : free.host;
        }
      });
    })
    .catch(() => {});

  return { ok: true, pid: res.pid, warnings };
}

function handleExit(id, info) {
  const wasStopping = stopping.has(id);
  if (wasStopping) stopping.delete(id);
  store
    .updateRuntime((r) => {
      const cur = r[id];
      if (!cur) return;
      if (cur.pid && info.pid && cur.pid !== info.pid) return; // 已被新一轮启动替换
      const okExit = info.code === 0 || wasStopping || !!info.signal;
      cur.status = okExit ? 'stopped' : 'error';
      cur.exitCode = info.code;
      cur.lastError = info.error || null;
      cur.stoppedAt = new Date().toISOString();
    })
    .catch(() => {});
}

// 停完之后再看一眼：进程会不会自己回来。
//
// 有守护进程托管时（launchd 的 KeepAlive / pm2），杀掉会被**立刻重新拉起**。
// 用户看到的现象是「点了停止、界面显示已停止，但端口马上又被占」，纯玄学。
// 这里把原因找出来，明确告诉他是什么在保活、怎么才能真正停掉。
async function checkResurrection(project, prevPid) {
  for (let i = 0; i < 6; i++) {
    await sleep(350);
    const entries = await ports.portEntriesByCwd(project.cwd);
    const back = entries.filter((e) => !project.port || Number(e.port) === Number(project.port));
    if (!back.length) continue;
    const hit = back[0];
    // 还是原来那个进程 → 只是没死透，不算「复活」（调用方已经报过 alive）
    if (prevPid && Number(hit.pid) === Number(prevPid)) return null;
    return { pid: hit.pid, port: hit.port, guardian: await guardian.detect(hit.pid) };
  }
  return null;
}

async function stopProject(id) {
  const { projects } = store.loadProjects();
  const project = projects.find((x) => x.id === id);
  if (!project) return { error: '项目不存在', code: 404 };

  const runtime = store.loadRuntime();
  const rt = runtime[id] || null;

  const clearRuntime = () =>
    store.updateRuntime((r) => {
      if (!r[id]) return;
      r[id].status = 'stopped';
      r[id].pid = null;
      r[id].pgid = null;
      r[id].adopted = false;
      r[id].stoppedAt = new Date().toISOString();
    });

  // 收尾：所有停止路径都要过一遍「复活检测」，把结论并进返回值。
  // 少了这一步，launchd / pm2 托管的项目在界面上就是「点了停止也没用」的玄学。
  const finish = async (result) => {
    const back = await checkResurrection(project, rt && rt.pid);
    if (!back) return result;
    const why = guardian.describe(back.guardian);
    result.resurrected = { pid: back.pid, port: back.port, guardian: back.guardian };
    result.warning = why
      ? '进程停掉后又被自动拉起来了（新 PID ' + back.pid + '，端口 ' + back.port + '）：' + why +
        '。平台停不掉它 —— 要先用它自己的方式停：' + guardian.unloadHint(back.guardian)
      : '进程停掉后又被自动拉起来了（新 PID ' + back.pid + '，端口 ' + back.port + '）—— ' +
        '多半有守护进程（launchd / pm2 / supervisor）在保活，平台停不掉它';
    return result;
  };

  // ① 填了「停止命令」→ 先按停止命令来
  if (project.stopCommand) {
    const res = await proc.runCommand(project, project.stopCommand, 30000);
    await sleep(1000); // 给服务一点退出时间

    const stillAlive = rt && rt.pid ? proc.isAlive(rt.pid) : false;
    if (!stillAlive) {
      await clearRuntime();
      return finish({ ok: true, via: 'script', exitCode: res.code });
    }

    // 脚本跑完进程还活着 → 退回默认方式，避免留下占着端口的孤儿
    stopping.add(id);
    const killed = await proc.stop(rt);
    stopping.delete(id);
    await clearRuntime();
    return finish({
      ok: true,
      via: 'script+kill',
      exitCode: res.code,
      warning:
        '停止命令已执行（退出码 ' +
        (res.code == null ? '超时' : res.code) +
        '），但进程仍在运行，已退回默认方式强制停止',
    });
  }

  // ② 没填 → 保持原来的做法
  if (!rt || !rt.pid) {
    // 记录里没有进程，但端口可能仍被占着（守护进程刚把服务拉起来，平台还没接管）。
    // 先查一次：没有就直接返回，免得「停止一个本来就没跑的项目」白等两秒。
    const live = await ports.portEntriesByCwd(project.cwd);
    const hit = live.find((e) => !project.port || Number(e.port) === Number(project.port));
    if (!hit) return { ok: true, alreadyStopped: true };
    return finish({ ok: true, alreadyStopped: true });
  }

  stopping.add(id);
  const res = await proc.stop(rt);
  stopping.delete(id);
  await clearRuntime();
  return finish(res);
}

async function restartProject(id) {
  await stopProject(id);
  await new Promise((r) => setTimeout(r, 500));
  return startProject(id);
}

// ---------------------------------------------------------------- 日志

// 该项目实际该读哪个日志文件：
//   - 用户填了「日志文件」→ 读它（支持 ~ 和「相对项目目录」的写法）
//   - 否则 → 读平台抓取的 stdout/stderr 日志
function effectiveLogFile(project) {
  const external = logs.resolveLogPath(project && project.logFile, project && project.cwd);
  if (external) return { file: external, external: true };
  return { file: logs.logPathFor(project.id), external: false };
}

function findProject(id) {
  const { projects } = store.loadProjects();
  return projects.find((p) => p.id === id) || null;
}

function getLogs(id, offset) {
  const project = findProject(id);
  if (!project) return { error: '项目不存在', code: 404 };
  const { file, external } = effectiveLogFile(project);
  const r = logs.readIncrementFrom(file, offset);
  return {
    logs: { data: r.data, offset: r.offset, size: r.size, exists: r.exists, file, external },
  };
}

function clearLogs(id) {
  const project = findProject(id);
  if (!project) return { error: '项目不存在', code: 404 };
  const { file, external } = effectiveLogFile(project);
  if (external) {
    // 外部日志是项目自己写的，平台没资格动
    return {
      error: '这是项目自己的日志文件，平台不主动清空（避免误删）。文件位置：' + file,
      code: 403,
      external: true,
    };
  }
  logs.clearFile(file);
  return { ok: true };
}

function logFilePath(id) {
  const project = findProject(id);
  if (!project) return logs.logPathFor(id);
  return effectiveLogFile(project).file;
}

// ---------------------------------------------------------------- 扫描导入

async function scanCandidates() {
  const { projects } = store.loadProjects();
  return scanner.scan(projects);
}

async function importCandidates(items) {
  const results = [];
  for (const it of items || []) {
    const r = await createProject({
      command: it.command,
      name: it.name,
      port: it.port,
      host: it.host,
    });
    if (r.error) {
      // 端口是唯一键 —— 被占用的候选直接跳过，不算失败
      results.push({ ok: false, name: it.name, error: r.error, skipped: !!r.portTaken });
      continue;
    }
    // 进程正在跑 → 直接接管，平台立刻能显示也能停掉它
    if (it.pid && proc.isAlive(it.pid)) {
      await store.updateRuntime((rt) => {
        rt[r.project.id] = {
          pid: it.pid,
          pgid: it.pgid || null,
          status: 'running',
          startedAt: new Date().toISOString(),
          adopted: true,
          logFile: logs.logPathFor(r.project.id),
        };
      });
    }
    results.push({ ok: true, id: r.project.id, name: r.project.name, adopted: !!(it.pid && proc.isAlive(it.pid)) });
  }
  return results;
}

// ---------------------------------------------------------------- 启动时恢复

async function verifyPid(rt, project) {
  let checked = false;

  // 手段一：进程的 cwd 应该等于项目目录。PID 被复用的话几乎不可能撞上同一个目录。
  const cwds = await ports.cwdsOfPids([rt.pid]);
  const cwd = cwds[rt.pid];
  if (cwd && project.cwd) {
    checked = true;
    if (ports.normPath(cwd) !== ports.normPath(project.cwd)) {
      return { ok: false, reason: '工作目录不匹配' };
    }
  }

  // 手段二：ps 的进程启动时间应与记录一致（ps 不可用则跳过）
  if (rt.startedAt) {
    const r = await exec('/bin/ps', ['-o', 'lstart=', '-p', String(rt.pid)]);
    if (r.ok && r.stdout.trim()) {
      const t = Date.parse(r.stdout.trim());
      if (Number.isFinite(t)) {
        checked = true;
        if (Math.abs(t - Date.parse(rt.startedAt)) > 120000) {
          return { ok: false, reason: '启动时间不匹配' };
        }
      }
    }
  }

  return { ok: true, checked };
}

// 老记录里只有端口号、没有地址。平台升级后补一次：能查到实际绑定地址的就补上。
// 不补的话，双栈场景下这些记录会一直按「地址未知」走保守判定，把不该拦的拦掉。
async function backfillHosts() {
  const { projects } = store.loadProjects();
  if (!projects.some((p) => p.port && !p.host)) return 0;
  const pmap = await livePortMap();
  let n = 0;
  await store.updateProjects((data) => {
    for (const p of data.projects) {
      if (!p.port || p.host) continue;
      const entries = pmap[ports.normPath(p.cwd || '.')] || [];
      const hit = entries.find((e) => Number(e.port) === Number(p.port));
      if (hit && hit.bindHost !== '*') {
        p.host = hit.host;
        n++;
      }
    }
  });
  return n;
}

async function recover() {
  await proc.initSelf();
  const hosts = await backfillHosts();

  const { projects } = store.loadProjects();
  const runtime = store.loadRuntime();
  const byId = new Map(projects.map((p) => [p.id, p]));
  let changed = false;

  for (const id of Object.keys(runtime)) {
    const rt = runtime[id];
    if (!rt || !rt.pid) continue;

    if (!byId.has(id)) {
      delete runtime[id]; // 项目已被删除
      changed = true;
      continue;
    }

    if (!proc.isAlive(rt.pid)) {
      rt.status = 'stopped';
      rt.pid = null;
      rt.pgid = null;
      changed = true;
      continue;
    }

    const v = await verifyPid(rt, byId.get(id));
    if (!v.ok) {
      rt.status = 'stopped';
      rt.pid = null;
      rt.pgid = null;
      rt.lastError = '平台重启时发现原 PID 已被其它进程占用（' + v.reason + '），已解除绑定';
      changed = true;
      continue;
    }

    rt.status = 'running';
    // ★ 不要无条件置 true —— adopted 是**持久化**的，记录的是「这个进程当初是谁启动的」，
    // 这件事不会因为平台重启而改变。无条件覆盖会把「平台启动的」也标成「外部启动」，
    // 重启一次整个列表就全变成「外部启动」，标记彻底失去意义。
    // 只有早期记录压根没有这个字段时，才按「外部启动」处理。
    if (rt.adopted === undefined || rt.adopted === null) rt.adopted = true;
    rt.verify = v.checked ? 'ok' : 'unverified';
    changed = true;
  }

  if (changed) await store.saveRuntime(runtime);
  return { recovered: Object.keys(runtime).length, hosts };
}

module.exports = {
  recover,
  listProjects,
  createProject,
  updateProject,
  deleteProject,
  startProject,
  stopProject,
  restartProject,
  getLogs,
  clearLogs,
  logFilePath,
  scanCandidates,
  importCandidates,
  portsOfCwd,
};
