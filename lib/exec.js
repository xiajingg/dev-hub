'use strict';

// 统一的外部命令执行封装。所有探测类命令（ps / lsof / pgrep）都走这里。
// 设计要点：永不 reject —— 调用方只需要判断 ok，避免某台机器上缺某个命令时整个面板挂掉。

const { execFile } = require('child_process');

const DEFAULTS = { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 8000 };

function exec(cmd, args, options) {
  return new Promise((resolve) => {
    const done = (err, stdout, stderr) =>
      resolve({
        ok: !err,
        code: err && typeof err.code === 'number' ? err.code : 0,
        stdout: stdout || '',
        stderr: stderr || '',
      });

    // Node 在 EPERM / EACCES 这类错误上是「同步抛出」而不是走回调 —— 必须包住，
    // 否则一个不可用的外部命令会把整个进程带崩（沙箱 / 权限受限环境尤其常见）。
    try {
      execFile(cmd, args || [], Object.assign({}, DEFAULTS, options || {}), done);
    } catch (err) {
      done(err, '', err && err.message ? err.message : String(err));
    }
  });
}

module.exports = { exec };
