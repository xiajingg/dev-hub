# dev-hub

本地项目启动管理平台。登记一次启动命令，打开面板就能看到所有项目在不在跑、
占哪个端口、吃多少内存、日志长什么样。

- **零依赖** —— 只用 Node 内置模块，不装任何 npm 包
- **不常驻** —— 前台运行，Ctrl+C 即停；平台关了，已启动的项目照常跑
- **不用 Docker** —— 直接在你本机跑，省内存

---

## 为什么做这个

做项目测试的时候，手头同时开着的项目会越来越多。麻烦的不只是「记不住启动命令」，
而是**管不过来**：

- **内存** —— 同时跑十几个服务，内存被吃掉一大块，却说不清是哪个项目吃的。
  想省内存得先知道谁在跑，而「知道谁在跑」这件事本身就很麻烦
- **容器太重** —— 为了省事把项目塞进 Docker，结果每个容器自己就要先吃掉几百 MB
  （虚拟机层 + 每个容器一份运行时）。开发机上跑三五个，内存就没了；
  而多数时候你只是想让这个服务跑起来看一眼，不需要隔离、不需要编排
- **端口** —— 想启一个新服务，提示端口被占。翻半天 `lsof` 才找到占用者，
  发现是上周忘了停的某个项目
- **状态** —— 有的跑在终端里、有的跑在容器里、有的被 launchd / pm2 托管，
  散落各处，没有一个地方能一眼看全

这个平台就是为这个场景做的：**登记一次，之后打开面板就能看到谁在跑、占哪个端口、
吃多少内存**；不用的直接点停止，内存和端口立刻释放。

> 它不替代 Docker / pm2 —— 那类工具解决的是「怎么让服务稳定常驻」。
> 这里解决的是**开发机上的临时项目**：今天要跑 A 和 B，明天只跑 C，
> 用完就该停掉、把资源还回来。

---

## 快速开始

```sh
cd ~/Documents/dev-hub
./start.sh
```

浏览器打开 **http://127.0.0.1:4321**

换端口：`PORT=4322 ./start.sh`

**环境要求**：macOS（依赖系统自带的 `lsof` / `ps`）、Node.js 18+

---

## 文档

| 文档 | 内容 |
|---|---|
| [docs/usage.md](docs/usage.md) | **用法**：登记项目、启停、看日志、停止命令、日志文件、扫描导入、端口规则、唯一键、守护进程（为什么有些服务停不掉）|
| [docs/cloudflare.md](docs/cloudflare.md) | **Cloudflare 域名**（可选）：把端口对上公网域名，自动同步 / 绑定 / 解绑 |
| [docs/internals.md](docs/internals.md) | **内部设计**：进程组与 detached、平台重启后如何认回项目、目录结构、HTTP API、已知限制 |

---

## 给 AI 用（skill + CLI）

仓库自带一个 skill，让 AI 助手能直接操作平台 —— 查状态、启停服务、看日志、登记项目。

```
skills/dev-hub/
├─ SKILL.md            给 AI 读的操作指南（触发词、工作流、必须知道的规则）
└─ scripts/devhub.js   命令行客户端（AI 用它，不用手搓 curl）
```

**装到你用的 AI 工具**（各家的 skills 目录）：

```sh
cp -R skills/dev-hub ~/.claude/skills/        # Claude Code
cp -R skills/dev-hub ~/.codex/skills/         # Codex
cp -R skills/dev-hub ~/.workbuddy-ai/skills/  # WorkBuddy
```

**也可以不装 skill，直接当命令行用：**

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

`<项目>` 可以是 id、完整名字、或名字的一部分。平台地址用 `DEVHUB_URL` 覆盖（默认 `http://127.0.0.1:4321`）。

> 改了 `skills/` 下的文件，记得重新 `cp` 到各 AI 工具的目录 —— 仓库是源，安装位置是副本。
