# 内部设计

代码怎么组织的、几个关键问题怎么解的、HTTP 接口清单、以及已知限制。

> 返回 [README](../README.md) · 日常用法见 [usage.md](usage.md)

---

## 设计要点

| 问题 | 做法 |
|---|---|
| 平台关了，项目还能跑吗？ | 能。子进程 `detached` 独立成新会话，stdout/stderr **直连日志文件 fd**（不用 pipe —— 用 pipe 的话平台一退出子进程会吃 SIGPIPE 死掉） |
| 停止时怎么不留孤儿进程？ | `detached` 让子进程成为进程组组长，`kill(-pid)` 一次干掉整棵树。只 kill 父 PID 的话，`npm run dev` 派生的子进程会变孤儿继续占端口 |
| 平台重启后还能认回项目吗？ | 能。PID 存活 + 进程 cwd + `ps` 启动时间三重校验，防止 PID 被系统复用后误认、误杀 |
| 端口怎么知道？ | 按工作目录反查监听端口（`lsof`），不依赖 `ps`，对终端手动启动的进程同样有效 |
| 数据在哪？ | `data/projects.json`（登记表）、`data/runtime.json`（运行状态）、`data/logs/<id>.log`（日志）。都是纯文本，可以直接改。用 `DEVHUB_DATA_DIR` 可把数据目录指到别处（跑临时实例时用，不会污染真实登记表） |

---

## 目录结构

```
dev-hub/
├─ start.sh             启动脚本
├─ server.js            HTTP 服务 + 路由 + 静态托管
├─ lib/
│  ├─ store.js          projects.json / runtime.json 原子读写
│  ├─ cmdparse.js       从「cd 路径 && 命令」解析 cwd
│  ├─ process.js        拉起 / 杀进程组 / 自定义命令 / 内存与存活探测
│  ├─ ports.js          lsof 端口与进程归属探测
│  ├─ portclass.js      端口分类：把一堆监听端口收敛成主端口
│  ├─ logs.js           日志落盘、轮转、增量读取、外部日志文件
│  ├─ scanner.js        扫描运行中的服务
│  ├─ guardian.js       守护进程探测（launchd / pm2 保活，解释「为什么停不掉」）
│  ├─ cloudflare.js     Cloudflare Tunnel：端口→域名映射、创建并绑定
│  └─ api.js            业务逻辑
├─ public/              前端（纯静态，无构建）
│  ├─ index.html        页面结构
│  ├─ style.css         样式
│  └─ app.js            逻辑：取数 → 行级 diff 渲染 → 日志增量滚动
├─ skills/dev-hub/      给 AI 用的 skill + CLI（见 README）
├─ docs/                文档
└─ data/                数据目录（首次运行自动创建）
```

---

## HTTP API

本地服务，只绑 `127.0.0.1`，不加鉴权（外部网络不可达，本机单用户）。

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/projects` | 项目列表 + 运行状态 |
| POST | `/api/projects` | 新增 |
| PUT | `/api/projects/:id` | 修改 |
| DELETE | `/api/projects/:id` | 删除（**只移除记录，不杀进程**） |
| POST | `/api/projects/:id/start` | 启动 |
| POST | `/api/projects/:id/stop` | 停止（有停止命令就先执行它） |
| POST | `/api/projects/:id/restart` | 重启 |
| GET | `/api/projects/:id/logs?offset=N` | 日志增量 |
| POST | `/api/projects/:id/logs/clear` | 清空日志（外部日志文件会被拒绝） |
| GET | `/api/projects/:id/logs/download` | 下载日志 |
| POST | `/api/cmd/parse` | 解析命令里的 `cd` |
| POST | `/api/ports/by-cwd` | 查某目录下在监听的服务端口 |
| POST | `/api/scan` | 扫描运行中的服务 |
| POST | `/api/import` | 导入选中的候选 |
| GET | `/api/cloudflare` | cloudflared 状态 + 端口→域名映射 + tunnel 列表 |
| POST | `/api/cloudflare/tunnel` | 创建 tunnel 并绑定域名（**会真的改 Cloudflare DNS**）|

---

## 已知限制

- **内存占用依赖 `ps`**。如果 `ps` 不可用（比如某些受限环境），会降级到 `top`，再不行就显示 `—`，不影响其它功能。
- **扫描导入的命令不是原始命令**，见 [usage.md 第 5 节](usage.md#5-扫描导入现有服务)。
- **外部启动的进程，之前的日志拿不到** —— 那些输出在你的终端里，平台无法回溯。之后的新输出才会进日志文件（如果项目有自己写日志，可以填「日志文件」来解决）。
- 同一个目录下同时跑多个服务时，靠「钉端口」区分；不钉的话按最小业务端口显示。
