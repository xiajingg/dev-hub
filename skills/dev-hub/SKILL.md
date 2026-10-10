---
name: dev-hub
description: 通过 dev-hub 平台查看、启动、停止、重启本机正在运行的开发服务。当用户说「帮我启动 xxx」「xxx 怎么没起来」「重启一下 xxx」「看看哪些服务在跑」「我本机跑了哪些项目」「查一下谁占了 5173 端口」「xxx 的日志」「把 xxx 加到管理平台」，或需要排查「服务起不来」「端口冲突」时使用。Use when the user asks to list, start, stop, restart or inspect local dev services/projects, find which process occupies a port, tail a running service's logs, or register a project into the local project launcher.
---

# dev-hub 操作指南

dev-hub 是本机的**项目启动管理平台**：登记一次「项目路径 + 启动命令」，之后就能查状态、启停、看日志。

- 默认地址：`http://127.0.0.1:4321`
- 项目目录：`~/Documents/dev-hub`
- 零依赖，只用 Node 内置模块；**不常驻**，前台运行

---

## 第一步：确认平台在跑

```sh
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4321/api/projects
```

返回 `200` 就可以继续。**连不上就停下来告诉用户**，让他自己在终端启动：

```sh
cd ~/Documents/dev-hub && ./start.sh
```

> ⚠️ **不要自己用后台任务启动平台。** 它是个前台服务，AI 起的后台进程会随对话结束被回收，
> 用户会遇到「刚才还能用，现在连不上」。让用户在自己终端里起。

---

## 首选：用 CLI，不要手搓 curl

```sh
DEVHUB=~/Documents/dev-hub/skills/dev-hub/scripts/devhub.js
```

`<项目>` 可以是 **id、完整名字、或名字的一部分**（唯一匹配即可）。

| 命令 | 作用 |
|---|---|
| `node $DEVHUB list` | 列出所有项目、状态、端口、PID、内存，以及 `[接管]` `[端口已变]` 等标记 |
| `node $DEVHUB start <项目>` | 启动。**若该服务本来就在跑，会直接接管而不是报冲突** |
| `node $DEVHUB stop <项目>` | 停止。有「停止命令」就先执行它 |
| `node $DEVHUB restart <项目>` | 重启 |
| `node $DEVHUB logs <项目> [行数]` | 打印日志尾部（默认 80 行） |
| `node $DEVHUB add "<命令>" [--name N] [--port P] [--stop "停止命令"] [--log 日志文件]` | 登记新项目 |
| `node $DEVHUB scan` | 扫描当前在跑的服务 |
| `node $DEVHUB import <名字>` | 把扫描到的某个服务导入 |
| `node $DEVHUB ports <目录>` | 查某目录下在监听的服务端口 |
| `node $DEVHUB parse "<命令>"` | 只解析命令里的 `cd`，不登记 |

平台地址不是默认值时：`DEVHUB_URL=http://127.0.0.1:4322 node $DEVHUB list`

---

## 常见请求 → 怎么做

**「我本机都跑了哪些服务？」**
→ `list`。输出里每条带状态、端口、PID、内存、工作目录。

**「xxx 怎么没起来？」**
→ 先 `list` 看状态。如果 `已停止` 或 `异常退出`，跑 `logs <项目>` 看报错。
`异常退出` 常见原因是端口冲突或依赖没装 —— 日志里会写明。

**「帮我启动 xxx」**
→ `start <项目>`。若返回「已接管」，说明它本来就在跑，平台只是纳管了它。

**「重启一下 xxx」**
→ `restart <项目>`。有自定义停止命令的会先执行停止命令。

**「谁占了 5173 端口？」**
→ 先 `list`，看哪个项目的 `监听端口` 里有 5173。
不在登记表里的进程，直接 `lsof -nP -iTCP:5173 -sTCP:LISTEN`。

**「把这个项目加到管理平台」**
→ 先 `parse "<用户给的命令>"` 确认能解析出目录，再 `add`。
**命令必须自带 `cd <绝对路径> &&`**（见下面的规则）。

**「我在终端手动起了个服务，也纳管进来」**
→ `scan` 看候选，再 `import <名字>`。导入时会**同时接管正在跑的进程**。

---

## 需要直接用 HTTP API 时

CLI 覆盖不到的场景（比如要批量操作、要看原始 JSON）：

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/projects` | 列表 + 运行状态 |
| POST | `/api/projects` | 新增 `{command, name?, port?, host?, env?, tags?, stopCommand?, logFile?}` |
| PUT | `/api/projects/:id` | 修改（同上字段） |
| DELETE | `/api/projects/:id` | **只移除记录，不杀进程** |
| POST | `/api/projects/:id/start` | 启动；若已在跑则返回 `{ok, adopted:true, pid, message}` |
| POST | `/api/projects/:id/stop` | 停止；`{ok, via:'script'\|'script+kill'}` 或 `{ok, killed:'SIGTERM'}` |
| POST | `/api/projects/:id/restart` | 重启 |
| GET | `/api/projects/:id/logs?offset=N` | 日志增量：`{data, offset, size, exists, file, external}` |
| POST | `/api/projects/:id/logs/clear` | 清空（外部日志文件会返回 403） |
| POST | `/api/cmd/parse` | `{command}` → `{ok, cwd, rest, exists, port, name}` |
| POST | `/api/ports/by-cwd` | `{cwd}` → `{services:[{port,host,bindHost,url,cmd}], hidden:[...]}` |
| POST | `/api/scan` | `{candidates:[...]}` |
| POST | `/api/import` | `{items:[{name,command,port,host,pid,pgid}]}` |

**`GET /api/projects` 返回的每条记录里，常用字段：**

| 字段 | 含义 |
|---|---|
| `status` | `running` / `stopped` / `error` |
| `port` / `host` | 当前**实时**主端口（可能与登记的不同） |
| `claimedPort` / `claimedHost` / `claimLabel` | 这条记录**登记时认领**的 `地址:端口` |
| `portStale` | `true` = 登记的端口已经没人在监听了（多半是服务换了端口） |
| `livePorts` / `hiddenPorts` | 全部在监听的端口 / 被折叠的内部与管理端口 |
| `portLinks` | `[{port, host, url, cmd, kind}]` —— 可直接打开的地址 |
| `adopted` | 是否「接管」（见下） |
| `external` | 进程不在平台名下，但端口有东西在听 |
| `orphan` | 平台启动过、进程已死但端口还被占着（残留） |
| `pid` / `pgid` / `memory` / `logSize` / `logPath` | |
| `stopCommand` / `logFile` | 用户配的可选项 |

---

## 必须知道的规则

### 1. 登记命令必须自带 `cd <绝对路径> &&`

`npm run dev`、`go run .`、`./scripts/start-local.sh` 这类命令全都依赖工作目录。
平台从 `cd` 里解析出目录，才能正确执行、显示、匹配端口。

```sh
# ✅ 正确
cd ~/projects/my-app && npm run dev
cd "~/projects/with space/app" && ./start.sh

# ❌ 会被拒绝
npm run dev
```

路径带空格要加引号，或用反斜杠转义；`~` 支持。

### 2. 唯一键是「地址 + 端口」，不是光端口号

TCP 监听表按 `(地址, 端口)` 索引。`127.0.0.1:5173` 和 `[::1]:5173` 是**两个不同的 socket**，
内核允许同时监听。macOS 的 `localhost` 同时指向这两个地址，所以 `localhost:5173` 和
`127.0.0.1:5173` **可能命中不同进程**。

平台据此判断冲突：地址不同就不算撞。地址未知（绑在 `*` 上）时走保守判定 —— 同端口一律视为冲突。

### 3. 「接管」是什么意思

带 `adopted: true` 表示**这个进程不是平台启动的，平台只是知道它的存在**。三种来源：

- 点「启动」时发现它已经在跑（占用者的**工作目录与本项目一致**）→ 直接接管
- 扫描导入的、终端里手动起的服务
- 平台自己重启后，发现原来的 PID 还活着 → 认回来

平台自己启动的项目不会有这个标记。

### 4. 删除 ≠ 停止

`DELETE` 只移除登记记录，**不会杀进程**。要停服务请显式调 `stop`。

### 5. 停止的三种路径

| 情况 | 返回 |
|---|---|
| 配了「停止命令」且生效 | `{ok:true, via:'script'}` |
| 配了但进程还活着 | `{ok:true, via:'script+kill', warning}` —— 自动退回强制停止 |
| 没配 | `{ok:true, killed:'SIGTERM'}` —— 杀整个进程组 |

默认停止是 `kill(-pgid)`，会连子进程一起清掉，不留孤儿。

### 6. 日志是增量读的

`GET /logs?offset=N` 返回从第 N 字节开始的新内容，同时给出新的 `offset`。
轮询时把上次的 `offset` 传回去，不要每次从 0 读。

`external: true` 表示这是**项目自己写的日志文件**，平台的「清空」会拒绝（403），不要试图清它。

### 7. 平台退出不影响已启动的项目

子进程是 `detached` 独立出去的，stdout/stderr 直连日志文件。用户关掉平台，服务照常跑。

---

## 安全边界

- **`stop` / `restart` 会真的影响用户正在用的服务。** 用户没明确要求就不要停任何东西。
  尤其是「接管」来的进程 —— 那可能是用户自己在终端里跑着的东西。
- **`delete` 是安全的**（不杀进程），但会丢记录。删之前确认用户要删。
- **别手改 `data/projects.json`。** 走 API，平台有原子写和并发队列保护。
- **`data/` 不要提交到 git。** 里面是用户全部项目的绝对路径。
- 拿不准某条记录是干嘛的，先 `list` + `logs` 看清楚再动手。
