#!/bin/sh
# dev-hub 启动脚本
#
# 前台运行，Ctrl+C 即停。平台本身不常驻、不占内存；
# 平台退出后，已经启动的项目会继续在后台跑（它们是被 setsid 独立出去的）。

cd "$(dirname "$0")" || exit 1

NODE=""
for c in node /usr/local/bin/node /opt/homebrew/bin/node; do
  if command -v "$c" >/dev/null 2>&1; then NODE="$c"; break; fi
done

if [ -z "$NODE" ]; then
  echo "找不到 node，请先安装 Node.js 18 或更高版本。" >&2
  exit 1
fi

exec "$NODE" server.js
