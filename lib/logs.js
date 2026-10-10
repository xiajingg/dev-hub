'use strict';

// 日志：每个项目一个文件，追加写入。
//
// 两种来源：
//   1) 默认 —— 平台拉起进程时，把它的 stdout/stderr 直接接到 data/logs/<id>.log 的 fd 上
//      （不用 pipe —— 否则平台一退出，管道读端消失，子进程写 stdout 会吃 SIGPIPE 直接死掉）
//   2) 外部日志文件 —— 项目自己写日志（如 logs/app.log），用户在编辑里填了路径，平台就 tail 它

const fs = require('fs');
const os = require('os');
const path = require('path');
const { LOGS_DIR } = require('./store');

const MAX_BYTES = 5 * 1024 * 1024; // 超过 5MB 就在下次启动前轮转
const KEEP_BYTES = 1 * 1024 * 1024; // 只保留尾部 1MB
const MAX_READ = 512 * 1024; // 单次读取上限，前端会继续轮询拿剩下的

function logPathFor(id) {
  return path.join(LOGS_DIR, String(id).replace(/[^\w.-]/g, '_') + '.log');
}

// 把用户填的日志路径解析成绝对路径。支持 ~ 和「相对项目目录」的写法。
function resolveLogPath(raw, cwd) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  let p = text;
  if (p === '~') p = os.homedir();
  else if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
  if (!path.isAbsolute(p)) p = path.join(cwd || process.cwd(), p);
  return path.normalize(p);
}

// 轮转只允许在「启动前」做：运行中 rename 会让子进程的 fd 仍指向旧 inode，日志会错位。
function rotateIfNeeded(id) {
  const file = logPathFor(id);
  let st;
  try {
    st = fs.statSync(file);
  } catch (_) {
    return;
  }
  if (st.size <= MAX_BYTES) return;
  const start = st.size - KEEP_BYTES;
  const buf = Buffer.alloc(KEEP_BYTES);
  let read = 0;
  const fd = fs.openSync(file, 'r');
  try {
    read = fs.readSync(fd, buf, 0, KEEP_BYTES, start);
  } finally {
    fs.closeSync(fd);
  }
  fs.writeFileSync(file, buf.subarray(0, read));
}

// 找出不超过 end 的最大 UTF-8 字符边界，避免把一个多字节汉字劈成两半显示成乱码
function utf8SafeEnd(buf, end) {
  let i = end;
  for (let steps = 0; i > 0 && steps < 4; steps++) {
    const b = buf[i - 1];
    if ((b & 0x80) === 0) return i; // ASCII，边界成立
    if ((b & 0xc0) === 0x80) {
      i--; // 续接字节，往前找起始字节
      continue;
    }
    const need = (b & 0xe0) === 0xc0 ? 2 : (b & 0xf0) === 0xe0 ? 3 : (b & 0xf8) === 0xf0 ? 4 : 1;
    return end - (i - 1) >= need ? end : i - 1;
  }
  return i;
}

function sizeOfFile(file) {
  try {
    return fs.statSync(file).size;
  } catch (_) {
    return 0;
  }
}

// 按 byte offset 增量读取。offset 超出文件大小（被清空 / 轮转过 / 文件被换掉）时从头读。
function readIncrementFrom(file, offset) {
  let size = 0;
  let exists = true;
  try {
    size = fs.statSync(file).size;
  } catch (_) {
    exists = false;
  }
  if (!exists) return { data: '', offset: 0, size: 0, exists: false };

  let from = Number(offset);
  if (!Number.isFinite(from) || from < 0 || from > size) from = 0;

  const len = size - from;
  if (len <= 0) return { data: '', offset: size, size, exists: true };

  const toRead = Math.min(len, MAX_READ);
  const buf = Buffer.alloc(toRead);
  let read = 0;
  const fd = fs.openSync(file, 'r');
  try {
    read = fs.readSync(fd, buf, 0, toRead, from);
  } finally {
    fs.closeSync(fd);
  }
  const end = utf8SafeEnd(buf, read);
  return { data: buf.toString('utf8', 0, end), offset: from + end, size, exists: true };
}

function readIncrement(id, offset) {
  return readIncrementFrom(logPathFor(id), offset);
}

// O_APPEND 下 truncate 是安全的，任何时候都能清空
function clearFile(file) {
  try {
    fs.truncateSync(file, 0);
  } catch (_) {
    /* 文件不存在即视为已清空 */
  }
  return true;
}

function clear(id) {
  return clearFile(logPathFor(id));
}

function sizeOf(id) {
  return sizeOfFile(logPathFor(id));
}

module.exports = {
  logPathFor,
  resolveLogPath,
  rotateIfNeeded,
  readIncrement,
  readIncrementFrom,
  clear,
  clearFile,
  sizeOf,
  sizeOfFile,
  MAX_BYTES,
  KEEP_BYTES,
};
