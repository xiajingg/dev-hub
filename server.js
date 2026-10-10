'use strict';

// dev-hub —— 本地项目启动管理平台
// 零依赖：只用 Node 内置模块。前台运行，Ctrl+C 即停，不常驻后台。
// 平台退出不影响已经启动的项目（子进程 detached + 日志写文件 fd）。

const http = require('http');
const fs = require('fs');
const path = require('path');

const store = require('./lib/store');
const api = require('./lib/api');
const cmdparse = require('./lib/cmdparse');

const PORT = Number(process.env.PORT) || 4321;
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------------------------------------------------------- 首次运行
// 不预置任何示例项目：示例里的绝对路径是本机私有的，不适合进公开仓库。
// 登记表为空时，前端会显示引导文案。

// ---------------------------------------------------------------- HTTP 工具

function sendJson(res, code, data) {
  const buf = Buffer.from(JSON.stringify(data), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_) {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

function downloadLog(res, id) {
  const file = api.logFilePath(id);
  fs.readFile(file, (err, buf) => {
    if (err) return sendJson(res, 404, { error: '日志文件不存在' });
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': buf.length,
      'Content-Disposition': 'attachment; filename="' + id + '.log"',
    });
    res.end(buf);
  });
}

// ---------------------------------------------------------------- 路由

async function handleApi(req, res, method, pathname, url) {
  const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await readBody(req) : {};

  if (pathname === '/api/projects') {
    if (method === 'GET') return sendJson(res, 200, { projects: await api.listProjects() });
    if (method === 'POST') {
      const r = await api.createProject(body);
      return sendJson(res, r.error ? r.code || 400 : 200, r.error ? { error: r.error } : r);
    }
  }

  const mProj = /^\/api\/projects\/([\w-]+)$/.exec(pathname);
  if (mProj) {
    const id = mProj[1];
    if (method === 'PUT') {
      const r = await api.updateProject(id, body);
      return sendJson(res, r.error ? r.code || 400 : 200, r.error ? { error: r.error } : r);
    }
    if (method === 'DELETE') {
      const r = await api.deleteProject(id);
      return sendJson(res, r.error ? r.code || 400 : 200, r);
    }
  }

  const mAct = /^\/api\/projects\/([\w-]+)\/(start|stop|restart)$/.exec(pathname);
  if (mAct && method === 'POST') {
    const id = mAct[1];
    const fn = { start: api.startProject, stop: api.stopProject, restart: api.restartProject }[mAct[2]];
    const r = await fn(id);
    return sendJson(res, r.error ? r.code || 400 : 200, r.error ? { error: r.error, portConflict: !!r.portConflict } : r);
  }

  const mLogs = /^\/api\/projects\/([\w-]+)\/logs$/.exec(pathname);
  if (mLogs && method === 'GET') {
    const r = api.getLogs(mLogs[1], url.searchParams.get('offset'));
    return sendJson(res, r.error ? r.code || 404 : 200, r.error ? { error: r.error } : r.logs);
  }

  const mClear = /^\/api\/projects\/([\w-]+)\/logs\/clear$/.exec(pathname);
  if (mClear && method === 'POST') return sendJson(res, 200, api.clearLogs(mClear[1]));

  const mDl = /^\/api\/projects\/([\w-]+)\/logs\/download$/.exec(pathname);
  if (mDl && method === 'GET') return downloadLog(res, mDl[1]);

  if (pathname === '/api/cmd/parse' && method === 'POST') {
    return sendJson(res, 200, cmdparse.parse(body.command));
  }

  if (pathname === '/api/scan' && method === 'POST') {
    return sendJson(res, 200, { candidates: await api.scanCandidates() });
  }

  if (pathname === '/api/ports/by-cwd' && method === 'POST') {
    return sendJson(res, 200, await api.portsOfCwd(body.cwd));
  }

  if (pathname === '/api/import' && method === 'POST') {
    return sendJson(res, 200, { results: await api.importCandidates(body.items) });
  }

  return sendJson(res, 404, { error: 'Not found: ' + method + ' ' + pathname });
}

const server = http.createServer(async (req, res) => {
  // 只绑回环地址 + 校验 Host 头，防 DNS rebinding
  const hostHeader = req.headers.host || '';
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(hostHeader)) {
    return sendJson(res, 403, { error: '只允许从本机访问' });
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://' + hostHeader).pathname);
  } catch (_) {
    return sendJson(res, 400, { error: '非法请求' });
  }

  const method = (req.method || 'GET').toUpperCase();
  try {
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, method, pathname, new URL(req.url, 'http://' + hostHeader));
    } else {
      serveStatic(res, pathname);
    }
  } catch (err) {
    sendJson(res, 500, { error: err && err.message ? err.message : '内部错误' });
  }
});

// ---------------------------------------------------------------- 启动

async function main() {
  store.ensureDirs();
  const rec = await api.recover();

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error('端口 ' + PORT + ' 已被占用。换一个端口：PORT=4322 ./start.sh');
    } else {
      console.error('启动失败：' + err.message);
    }
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    console.log('');
    console.log('  dev-hub 已启动   →   http://' + HOST + ':' + PORT);
    console.log('  数据目录          →   ' + store.DATA_DIR);
    console.log('  已恢复 ' + rec.recovered + ' 条运行时记录');
    console.log('');
    console.log('  Ctrl+C 停止平台。已启动的项目不受影响，会继续在后台运行。');
    console.log('');
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
