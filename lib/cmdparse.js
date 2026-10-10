'use strict';

// 命令解析：从用户粘贴的「cd <绝对路径> && 命令」里把工作目录抠出来。
//
// 为什么要单独做这件事：绝大多数启动命令都依赖工作目录（npm run dev / go run . /
// ./scripts/start-local.sh 全是相对路径），所以「只粘一条命令」的前提是平台能可靠地
// 从命令里拿到 cwd。项目目录常常带空格，所以必须处理引号与转义。

const fs = require('fs');
const os = require('os');
const path = require('path');

// 锚定在命令开头：cd <路径> 后面跟 && / ; / || / 换行
const CD_RE = /^\s*cd\s+([\s\S]+?)\s*(?:&&|;|\|\||\r?\n)/;

function unquote(raw) {
  const p = String(raw).trim();
  if (p.length >= 2) {
    const a = p[0];
    const b = p[p.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) {
      return p.slice(1, -1);
    }
  }
  // 反斜杠转义写法：cd ~/projects/with\ space/app
  return p.replace(/\\(.)/g, '$1');
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// 从命令里「猜」端口，仅用于表单预填。真正准确的端口在启动后由 lsof 探测回填。
function guessPort(text) {
  const patterns = [
    /--port[=\s]+(\d{1,5})/i,
    /--server\.port[=\s]+(\d{1,5})/i,
    /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d{2,5})/,
    /:(\d{4,5})\b/,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) {
      const n = Number(m[1]);
      if (n > 0 && n < 65536) return n;
    }
  }
  return null;
}

const HINT =
  '命令必须以 cd <绝对路径> && 开头。例如：cd ~/projects/my-app && npm run dev';

function parse(raw) {
  const text = String(raw == null ? '' : raw);
  if (!text.trim()) return { ok: false, error: '命令为空' };

  const m = CD_RE.exec(text);
  if (!m) return { ok: false, error: HINT };

  const cwd = expandHome(unquote(m[1]));
  if (!path.isAbsolute(cwd)) {
    return { ok: false, error: '解析出的目录不是绝对路径：' + cwd };
  }

  let exists = false;
  try {
    exists = fs.statSync(cwd).isDirectory();
  } catch (_) {
    exists = false;
  }

  const rest = text.slice(m.index + m[0].length).trim();

  return {
    ok: true,
    cwd,
    rest,
    exists,
    port: guessPort(text),
    name: path.basename(cwd) || cwd,
  };
}

// 把 cwd 安全地拼成可粘贴的 cd 片段（路径含空格时加双引号）
function cdPrefix(cwd) {
  return /\s/.test(cwd) ? 'cd "' + cwd + '"' : 'cd ' + cwd;
}

module.exports = { parse, guessPort, cdPrefix, HINT };
