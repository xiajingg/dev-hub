# Cloudflare 域名（可选）

平台能把项目的端口和公网域名对上，列表里多一列「域名」，点一下就能打开。

> 返回 [README](../README.md) · 日常用法见 [usage.md](usage.md)

---

## 两种模式

**优先用 API 模式。**

| 模式 | 怎么来的 | 能读到什么 |
|---|---|---|
| **API 模式**（推荐） | 你配一个 Cloudflare API Token | **账号下所有 tunnel 的配置** —— 包括在 Cloudflare 后台建的（token 模式）。那种本地根本没有配置文件，只有 API 读得到 |
| **本地模式** | 读 `~/.cloudflared/config.yml` | 只有本机 `config.yml` 里写的规则 |

---

## 配 API Token（一次性）

1. 去 [Cloudflare Dashboard](https://dash.cloudflare.com/profile/api-tokens) → My Profile → API Tokens → **Create Token**
2. 用 **Custom token**，权限加**三条** —— 缺任何一条都会在对应步骤失败：

   | 权限 | 干什么用的 | 缺了会怎样 |
   |---|---|---|
   | `Account` → `Cloudflare Tunnel` → **Read** | 读 tunnel 列表和配置 | 同步结果为空，一个域名都看不到 |
   | `Zone` → `Zone` → **Read** | 查域名对应的 zone id | 绑定时报「**账号下找不到域名 xxx**」——**这个提示很误导，看着像域名不在你账号下，其实是没给 Zone 权限** |
   | `Zone` → `DNS` → **Edit** | 建 / 删 CNAME 记录 | 绑定时报没权限 |

   > 加完 Zone 权限后，页面下方会多出一栏 **「区域资源」** —— 必须选 `包括` → 你的域名（或「所有区域」）。
   > 只配了 Account 权限时，这一栏根本不会出现，所以得**先加 Zone 权限**才看得到。
3. 在平台的「编辑项目 → Cloudflare 域名」里点「用 API Token 自动同步」，填三样：
   - **API Token** —— 上一步生成的
   - **Account ID** —— Cloudflare 后台右侧栏能看到
   - **域名** —— 你的主域名，例如 `example.com`（填一次，之后只用填前缀）

配好之后**全自动**：面板每次刷新都会同步 Cloudflare 上的配置（30 秒缓存），
填个前缀点「绑定」就行，不用再去后台手动加规则。

> Token 存在 `data/cloudflare.json`，权限 600，`data/` 已被 `.gitignore` 排除。
> 平台**只判断它存不存在，绝不回显内容**（界面上只显示 `前6位…后4位`）。

---

## 本地模式的行为

不想用 API 模式的话，下面是本地模式的表现。

**分三档处理，取决于本机的实际状态**：

| 状态 | 平台怎么做 |
|---|---|
| **没装 cloudflared** | 表单里提示一句 + 给官网链接。**不引导安装** —— 用不用你自己决定 |
| **装了但没登录** | 提示先跑一次 `cloudflared tunnel login`（浏览器授权，必须你本人点，平台代劳不了）|
| **已登录** | 列表显示每个端口绑定的域名；表单里填「前缀 + 域名」就能新建 tunnel 并绑定 |

**映射是从哪来的**：读 `~/.cloudflared/config.yml` 里的 `ingress` 规则 ——
`hostname: myapp.example.com` 和 `service: http://localhost:5173` 这样的配对，
平台按 `service` 里的端口把它挂到对应项目上。

**本地模式下**「绑定」会做三件事（都会真的动你的 Cloudflare）：

1. `cloudflared tunnel create <名字>` —— 已有同名 tunnel 就**复用**，不重复建
2. `cloudflared tunnel route dns <名字> <前缀.域名>` —— 加一条 CNAME
3. 往 `~/.cloudflared/config.yml` 的 `ingress` 里插一条规则 —— **改之前先备份**，备份路径在返回里

---

## 绑定与解绑

**API 模式下**「绑定」同样是三件事，但全走 API、不碰本地文件：

1. 复用你现有的 tunnel（没有才新建）
2. 读现有 `ingress`，**追加**一条规则再整体写回 —— 其他规则原样保留
3. 建 DNS CNAME

**解绑**（两种模式都有）：已绑定的域名后面有个「解绑」按钮。它会
**先摘掉 tunnel 配置里的那条规则，再删 DNS 记录** —— 顺序不能反，否则会留下一条指向死域名的规则。
其他规则和 404 兜底都不动。

> ⚠️ 绑定和解绑都会**真的修改 Cloudflare**（配置 + DNS），所以都必须你点按钮才执行。

**平台刻意不做的事**：

- **不帮你登录** —— `tunnel login` 是浏览器授权流程，只能本人操作
- **不自动跑 tunnel** —— 建完会提示怎么跑；要不要开机自启（`sudo cloudflared service install`）你自己定
- **本地模式读不到 token 模式的 tunnel** —— 那种配置存在 Cloudflare 后台、本地只有个 token 文件。
  这种情况请用 **API 模式**，它读的就是后台的配置
