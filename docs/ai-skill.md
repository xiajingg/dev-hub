# 给 AI 用（skill + CLI）

仓库自带一个 skill，让 AI 助手能直接操作平台 —— 查状态、启停服务、看日志、登记项目。

> 返回 [README](../README.md) · 日常用法见 [usage.md](usage.md)

---

## 里面有什么

```
skills/dev-hub/
├─ SKILL.md            给 AI 读的操作指南（触发词、工作流、必须知道的规则、安全边界）
└─ scripts/devhub.js   命令行客户端（AI 用它，不用手搓 curl）
```

`SKILL.md` 里写死了几条 AI 容易踩、踩了后果最重的规则，比如：平台**不常驻**所以连不上时
要让用户自己启动、`stop`/`restart` 会**真的影响用户在用的服务**、`delete` 只删记录不杀进程、
唯一键是「地址 + 端口」、被 launchd / pm2 托管的服务平台停不掉。

---

## 安装

复制到你所用的 AI 工具的 skills 目录：

```sh
cp -R skills/dev-hub ~/.claude/skills/        # Claude Code
cp -R skills/dev-hub ~/.codex/skills/         # Codex
cp -R skills/dev-hub ~/.workbuddy-ai/skills/  # WorkBuddy
```

装完可以让 AI 试一句「我本机都跑了哪些服务」，能列出项目就说明通了。

> ⚠️ **仓库是源，安装位置是副本。** 改了 `skills/` 下的文件，要重新 `cp` 一遍才生效。

---

## 不装 skill 也能用：直接当命令行

```sh
node skills/dev-hub/scripts/devhub.js list
node skills/dev-hub/scripts/devhub.js start  my-api
node skills/dev-hub/scripts/devhub.js logs   my-api 50
node skills/dev-hub/scripts/devhub.js stop   my-web
```

| 命令 | 作用 |
|---|---|
| `list` | 列出所有项目、状态、端口、PID、内存，以及 `[平台启动]` `[外部启动]` `[端口已变]` 等标记 |
| `start` / `stop` / `restart <项目>` | 启停重启（`start` 会自动接管已在跑的服务） |
| `logs <项目> [行数]` | 打印日志尾部（默认 80 行） |
| `add "<命令>" [--name --port --host --stop --log]` | 登记新项目 |
| `scan` / `import <名字>` | 扫描当前在跑的服务并导入 |
| `ports <目录>` | 查该目录下在监听的端口 |
| `parse "<命令>"` | 只解析命令里的 `cd`，不登记 |
| `help` | 全部用法 |

`<项目>` 可以是 **id、完整名字、或名字的一部分**（唯一匹配即可）。
平台地址用 `DEVHUB_URL` 覆盖（默认 `http://127.0.0.1:4321`）：

```sh
DEVHUB_URL=http://127.0.0.1:4322 node skills/dev-hub/scripts/devhub.js list
```

平台没在跑时，CLI 会直接提示 `cd ~/Documents/dev-hub && ./start.sh`，
而不是抛一个看不懂的连接错误。

---

## 一个前提

**平台必须先跑起来**，skill 和 CLI 才有意义 —— 它们只是客户端。

```sh
cd ~/Documents/dev-hub && ./start.sh
```

平台是**前台服务**，要让用户在自己的终端里启动。**AI 不要用后台任务去起它** ——
那种进程会随对话结束被回收，用户会遇到「刚才还能用，现在连不上」。
