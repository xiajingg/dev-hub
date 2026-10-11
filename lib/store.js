'use strict';

// 持久化层：projects.json（登记表，低频变更） + runtime.json（运行时状态，高频变更）
// 分开两个文件，避免每次更新 PID 都重写整个登记表。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// 数据目录可以用 DEVHUB_DATA_DIR 覆盖 —— 跑临时实例（测试、验证）时用它指向别处，
// 避免污染真实登记表。默认还是项目下的 data/。
const DATA_DIR = process.env.DEVHUB_DATA_DIR
  ? path.resolve(process.env.DEVHUB_DATA_DIR)
  : path.join(ROOT, 'data');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const RUNTIME_FILE = path.join(DATA_DIR, 'runtime.json');

// ---------------------------------------------------------------------------
// 串行写队列：所有「读-改-写」排队执行，避免并发请求互相覆盖。
// ---------------------------------------------------------------------------
let chain = Promise.resolve();

function enqueue(task) {
  const run = chain.then(task, task);
  // 无论成功失败都让队列继续，否则一次失败会卡死后续所有写入
  chain = run.then(
    () => {},
    () => {}
  );
  return run;
}

function ensureDirs() {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function readJsonSync(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    // 文件损坏：先备份现场，再返回兜底值，避免静默丢数据
    try {
      fs.copyFileSync(file, file + '.corrupt-' + Date.now());
    } catch (_) {
      /* ignore */
    }
    return fallback;
  }
}

// 原子写：先写同目录临时文件，再 rename 覆盖（POSIX 同目录 rename 是原子操作）。
// 这样即使进程被 Ctrl+C 打断，也不会留下半个 JSON。
async function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.promises.rename(tmp, file);
}

function loadProjects() {
  const data = readJsonSync(PROJECTS_FILE, null);
  if (!data || !Array.isArray(data.projects)) return { version: 1, projects: [] };
  return data;
}

function loadRuntime() {
  const data = readJsonSync(RUNTIME_FILE, null);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  return data;
}

function updateProjects(mutator) {
  return enqueue(async () => {
    const data = loadProjects();
    const out = await mutator(data);
    await writeJsonAtomic(PROJECTS_FILE, data);
    return out;
  });
}

function updateRuntime(mutator) {
  return enqueue(async () => {
    const data = loadRuntime();
    const out = await mutator(data);
    await writeJsonAtomic(RUNTIME_FILE, data);
    return out;
  });
}

function saveProjects(data) {
  return enqueue(() => writeJsonAtomic(PROJECTS_FILE, data));
}

function saveRuntime(data) {
  return enqueue(() => writeJsonAtomic(RUNTIME_FILE, data));
}

module.exports = {
  ROOT,
  DATA_DIR,
  LOGS_DIR,
  PROJECTS_FILE,
  RUNTIME_FILE,
  ensureDirs,
  loadProjects,
  loadRuntime,
  updateProjects,
  updateRuntime,
  saveProjects,
  saveRuntime,
};
