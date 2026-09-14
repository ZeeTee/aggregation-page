# aggregation-page TypeScript 重构 · 架构与实施方案

> 状态:**设计稿(待评审)**,尚未开始实施。
> 目标读者:实施者本人 / 未来的自己。
> 前置阅读:`README.md`(当前 Python 版的用法与部署方式)。

---

## 1. 目标与范围

把现有 Python 实现的「小工具集合站」升级为 TypeScript 工程,并支持**后端能力**(调外部 API、服务端计算、读写受控资源)。

**范围内**

- 门户页(工具卡片 / 搜索 / 标签过滤)
- 各工具页面与其前端逻辑
- 构建期工具元数据扫描与校验
- 单文件 Node 服务:静态托管 + `/api/*` 后端路由
- 部署形态调整(systemd 启动 Node 服务)

**范围外(保持不变)**

- Cloudflare 隧道:仍回源 `127.0.0.1:8080`,配置与 DNS 不动
- 域名、HTTPS、备案策略:不变
- `tools/<slug>/tool.json` 的字段约定:保持兼容(见 §6)
- 与 `ai-news-daily` 工程完全解耦

**非目标(本期不做)**

- SSR / 服务端渲染、数据库、用户体系
- 多环境(dev/staging/prod)编排、容器化

---

## 2. 已确认的技术决策

| 决策项 | 结论 | 理由 |
| --- | --- | --- |
| 语言 | **TypeScript 5.x**(strict) | 前后端同语言,共享类型 |
| 后端 | **方案 B**:单进程同时托管静态文件与 `/api/*` | 工具有服务端需求 |
| UI | **纯 TS + 原生 DOM**,不引入框架 | 工具交互量小,产物体积与内存最省 |
| 生产服务层 | **Node 单文件静态服务**(不用 Python 版) | 该工程彻底不依赖 Python |
| 构建 | **Vite**(前端 MPA)+ **esbuild**(服务端打包) | 成熟、快、依赖少 |
| 包管理 | **npm 10**(registry 已指向 npmmirror) | 机器上现成可用 |
| 运行时依赖 | **0 个**(生产) | 只有 devDependencies |

**机器约束(实测)**:内存总 1.86 GB / 可用约 900 MB,2 vCPU,磁盘 25 GB 可用,Node v22.23.0。
→ 禁止引入 Next.js/Nuxt 这类重框架;构建时限制 Node 堆(`--max-old-space-size=512`)。

---

## 3. 总体架构

```
                       访客浏览器
                            │ HTTPS
                  Cloudflare 边缘(自动证书、压缩、缓存)
                            │
                  cloudflared 隧道(已有,不改)
                            │ http://127.0.0.1:8080
        ┌───────────────────┴───────────────────┐
        │   Node 单进程(server/index.ts)        │
        │                                       │
        │  /            → dist/ 静态文件托管     │
        │  /tools/*/    → dist/tools/*/          │
        │  /api/*       → 路由表(server/routes) │
        │  /healthz     → 健康检查               │
        └───────────────────┬───────────────────┘
                            │ (仅后端工具需要)
                    外部 API / 本机受控资源
```

**构建期数据流**

```
tools/<slug>/tool.json ─┐
                        ├─► Vite 插件扫描 + 校验
tools/<slug>/index.html ┘        │
                                 ├─► virtual:tools  ──► 门户页渲染卡片(类型安全)
                                 ├─► dist/tools.json ─► 机器可读清单
                                 └─► rollup input    ─► 每个工具一个独立入口(MPA)
src/shared/*  ◄────────────── 前后端共享类型(API 契约)
server/routes/* ─────────────► esbuild 打包 ─► dist-server/index.js
```

**为什么 MPA 而不是 SPA**:每个工具是独立页面(URL 仍是 `/tools/<slug>/`),互不影响、按需加载、单页崩溃不牵连全站;也免去路由库。

---

## 4. 目录结构(目标态)

```
aggregation-page/
├── package.json
├── tsconfig.json                 # 前端(dom lib)
├── tsconfig.server.json          # 服务端(node lib)
├── vite.config.ts
├── index.html                    # 门户入口(仅挂载点 + module 引用)
├── .env.example                  # 服务端环境变量样例(.env 不入库)
│
├── src/
│   ├── hub/
│   │   ├── main.ts               # 门户:搜索、标签过滤、卡片渲染
│   │   └── hub.css
│   ├── shared/                   # ★ 前后端共享(不得 import 任何 node 内置模块)
│   │   ├── types.ts              # ToolMeta、ApiResult 等类型
│   │   ├── api.ts                # callApi<T>() 客户端封装
│   │   ├── dom.ts                # el()/on()/qs() 等极简 DOM 助手
│   │   ├── toast.ts              # 提示条
│   │   └── clipboard.ts          # 复制(含失败降级)
│   └── build/
│       ├── tools.ts              # 扫描 tools/ + 校验 tool.json(纯函数,可单测)
│       └── tools-plugin.ts       # Vite 插件:virtual:tools + 产物
│
├── tools/                        # 一个目录一个工具(约定不变)
│   ├── timestamp/{tool.json, index.html, main.ts, style.css}
│   └── json-format/{tool.json, index.html, main.ts, style.css}
│
├── server/
│   ├── index.ts                  # 入口:组装 http server
│   ├── static.ts                 # 静态文件:路径校验/MIME/ETag/缓存头
│   ├── api.ts                    # /api 分发、JSON 解析、统一错误信封
│   ├── security.ts               # 限流、体积限制、安全响应头
│   ├── log.ts                    # 结构化日志
│   ├── env.ts                    # .env 读取与校验
│   └── routes/
│       ├── index.ts              # 路由注册表(显式 import,类型安全)
│       ├── health.ts             # GET /api/health
│       └── _example.ts           # 后端工具路由样例(实施时替换)
│
├── scripts/
│   ├── dev.ts                    # 同时起 Vite 与 Node(--watch)
│   ├── build-server.ts           # esbuild 打包服务端
│   └── smoke.ts                  # 部署后冒烟:逐个 URL 断言状态码
│
├── public/                       # 原样拷贝的静态资源(favicon 等)
├── dist/                         # 前端构建产物(gitignore)
├── dist-server/                  # 服务端构建产物(gitignore)
└── deploy/
    ├── aggregation-page.service  # 改为启动 Node
    └── aggregation-page.env.example
```

---

## 5. 工程配置

### 5.1 npm scripts

```jsonc
{
  "scripts": {
    "dev":            "node scripts/dev.ts",              // Vite + Node 双进程
    "dev:web":        "vite",
    "dev:api":        "node --watch server/index.ts",
    "build":          "npm run build:web && npm run build:server",
    "build:web":      "vite build",
    "build:server":   "node scripts/build-server.ts",
    "start":          "node dist-server/index.js",
    "typecheck":      "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.server.json --noEmit",
    "test":           "vitest run",
    "smoke":          "node scripts/smoke.ts"
  }
}
```

> **Node 直接跑 `.ts` 的前提**:Node 22 内置类型剥离。需在实施第一步验证本机是否需显式加
> `--experimental-strip-types`;若需,则统一在 scripts 里带上该参数。
> 约束:剥离模式不支持 `enum`、`namespace`、构造器参数属性等「非可擦除语法」——
> 服务端代码**统一用 `const` 对象 + union 类型**代替 `enum`。
> 生产环境不依赖该特性(服务端由 esbuild 打包成 JS)。

### 5.2 devDependencies(预计 5 个)

| 包 | 用途 |
| --- | --- |
| `typescript` | 类型检查 |
| `vite` | 前端构建与 dev server |
| `esbuild` | 服务端打包(显式声明,不依赖传递依赖) |
| `vitest` | 单测 |
| `@types/node` | Node 类型 |

生产**零依赖**:`dist-server/index.js` 只 import `node:*` 内置模块。

### 5.3 vite.config.ts 关键点

```ts
export default defineConfig({
  plugins: [toolsPlugin()],                 // §6
  build: {
    outDir: 'dist',
    rollupOptions: { input: collectEntries() },   // index.html + tools/*/index.html
    target: 'es2022',
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8080' },   // 开发期前后端同源
  },
});
```

---

## 6. 工具元数据契约(兼容现有)

`tools/<slug>/tool.json` **字段完全沿用现版**,保证工具可增量迁移:

```jsonc
{
  "name": "时间戳转换",        // 必填
  "description": "…",          // 可选
  "tags": ["时间", "开发"],     // 可选
  "icon": "🕒",                // 可选,默认 🧰
  "status": "ready",           // ready | wip
  "order": 10                  // 越小越靠前,默认 100
}
```

**新增可选字段(本期可加,不破坏旧数据)**

| 字段 | 说明 |
| --- | --- |
| `api: true` | 标记该工具需要后端(`/api/<slug>/*`),门户卡片显示「需服务端」 |
| `hidden: true` | 不在门户展示,但仍构建(便于灰度/内部工具) |

**校验规则(构建期,失败即中断构建)**

- 目录名:ASCII、`[a-z0-9-]+`,长度 ≤ 40;以 `_`/`.` 开头则跳过
- `name` 必填非空;`tags` 必须是字符串数组;`order` 必须是整数
- 必须有 `index.html`;若有 `api: true`,则 `server/routes/` 必须存在同名路由文件

**导出接口**

```ts
// src/shared/types.ts
export interface ToolMeta {
  slug: string; name: string; description: string;
  tags: string[]; icon: string; status: 'ready' | 'wip';
  order: number; api?: boolean; hidden?: boolean;
}

// src/build/tools-plugin.ts
export function toolsPlugin(): Plugin;   // 提供 virtual:tools 与 dist/tools.json
```

```ts
// 门户侧使用(类型安全,构建期注入)
import { tools } from 'virtual:tools';
```

---

## 7. Node 服务设计(单文件入口 + 模块拆分)

### 7.1 静态托管(`server/static.ts`)

- 路径解析:URL 解码 → 规范化 → **必须落在 `dist/` 前缀内**(否则 403),防目录穿越
- 目录访问:补 `index.html`;文件不存在 → 404 页
- 缓存策略:
  - `dist/assets/*`(带内容哈希)→ `Cache-Control: public, max-age=31536000, immutable`
  - `*.html` / `tools.json` → `no-cache`(改完刷新即见)
- `ETag` + `If-None-Match` → 304
- MIME 表:html/css/js/json/svg/png/ico/woff2/txt/md
- **不做压缩**:交给 Cloudflare 边缘自动 gzip/brotli,减少本机 CPU

### 7.2 API 层(`server/api.ts`)

统一响应信封,前后端共用类型:

```ts
// src/shared/types.ts
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

export interface Route {
  method: 'GET' | 'POST';
  path: string;                                  // 形如 '/api/echo'
  handle(ctx: RouteCtx): Promise<unknown>;
}
export interface RouteCtx {
  query: URLSearchParams;
  body: unknown;                                 // 已解析的 JSON(≤64KB)
  ip: string;                                    // 取 CF-Connecting-IP
  req: import('node:http').IncomingMessage;
}
```

- 路由表在 `server/routes/index.ts` **显式注册**(不用文件系统魔法,便于类型检查与审查)
- 请求体上限 64 KB;超限 413
- 单请求超时 10 s;超时 504
- 未捕获异常 → 500,日志记录堆栈,**不**把堆栈返回给客户端
- `GET /api/health`、`GET /api/tools`(读 `tools.json`)为内置路由

### 7.3 安全边界(站点经隧道对公网开放,必须遵守)

| 规则 | 说明 |
| --- | --- |
| 只读优先 | 后端工具默认只做计算或调外部只读 API;有副作用的接口单独评审 |
| 禁止任意文件访问 | 不接受任意路径;需要文件的服务端必须用**白名单目录 + 固定文件名** |
| 禁止 shell | 不得 `child_process.exec`;确需执行外部命令时,必须固定命令 + 参数白名单 |
| 出网白名单 | 后端调外部 API 时,目标域名写死在代码里的**常量表**,不接受用户传入 URL(防 SSRF) |
| 密钥只在服务端 | `.env` 读取,严禁进入前端 bundle(`src/shared` 不得引用 `server/env.ts`) |
| 限流 | `/api/*` 每 IP 60 次/分钟(内存令牌桶);超限 429 |
| 安全响应头 | `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Permissions-Policy` 收紧、`Content-Security-Policy` 默认仅允许同源脚本 |
| 可选加固 | 对写操作/管理接口用 **Cloudflare Access** 单独加保护;或加一层的 `API_TOKEN` 校验 |

### 7.4 日志

- stdout 输出 JSON Lines:`{ts, method, path, status, ms, ip, ua, cfRay}`,由 journald 收集
- `journalctl -u aggregation-page -f` 直接可读
- 不记录请求体(避免密钥/隐私落盘)

### 7.5 生命周期

- 启动时:加载 `.env` → 校验 `dist/` 存在(否则报错退出,避免"空站"上线)→ 监听 `127.0.0.1:8080`
- `SIGTERM`:停止接受新连接 → 等待在途请求(最多 5 s)→ 退出(配合 systemd 平滑重启)
- 不自动重建站点(与 Python 版的差异):改内容走 `npm run build`;**开发期**用 Vite HMR,不需要请求触发重建

---

## 8. 部署与运维

### 8.1 systemd 单元(替换现有)

```ini
[Unit]
Description=aggregation-page 在线工具箱(Cloudflare 隧道的本地源站)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/root/dshworkspace/aggregation-page
Environment=NODE_ENV=production
EnvironmentFile=-/root/dshworkspace/aggregation-page/.env
ExecStart=/usr/bin/node dist-server/index.js
Restart=always
RestartSec=3
MemoryMax=384M
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

### 8.2 发布流程(手动,后续可脚本化)

```bash
cd /root/dshworkspace/aggregation-page
npm ci                 # 按 lockfile 安装(不改依赖版本)
npm run typecheck      # 类型检查必须通过
npm test               # 单测
npm run build          # dist/ + dist-server/
npm run smoke -- --local          # 本地冒烟
sudo systemctl restart aggregation-page
npm run smoke -- --public         # 线上冒烟(https://www.zeetng.cloud)
```

### 8.3 回滚

1. **首选**:保留 Python 版代码与产物 → `systemctl stop aggregation-page-python` 之前先 `enable`;
   切换只需改 `ExecStart` 并 `daemon-reload`。
2. 验收通过并稳定运行一周后,再删除 Python 实现(git 历史仍可追溯)。

### 8.4 隧道与域名

**不需要任何改动**:`www.zeetng.cloud → http://127.0.0.1:8080` 保持不变。

---

## 9. 分阶段实施计划

| 阶段 | 内容 | 产出 | 验收标准 | 预估 |
| --- | --- | --- | --- | --- |
| **P0 环境验证** ✅ | ~~临时目录试装 devDeps;确认 Node 类型剥离行为;确认构建耗时/内存~~ | 见 §14 实施记录 | 装依赖 11s;构建 0.1s;类型剥离免参数可用 | 0.5 h |
| **P1 前端骨架** ✅ | ~~工程初始化、tsconfig、Vite 配置、工具扫描 + 插件、门户页、示例工具迁移~~ | `src/`、`tests/`、`dist/` | typecheck 通过;21 个测试全绿;门户功能等价 | 4–6 h |
| **P2 服务端** | `server/*` 全部模块、健康检查、示例路由、限流与安全头 | `npm start` 后可访问站点与 `/api/health` | 目录穿越/超限/限流用例返回 403/413/429;`/api` 未注册路径 404 | 4–6 h |
| **P3 上线切换** | 构建脚本、systemd 单元、冒烟脚本;在 8080 上完成切换 | 线上 `https://www.zeetng.cloud` 由 Node 服务承接 | 所有工具页 200;HTML no-cache;静态资源命中缓存;重启后自动恢复 | 2 h |
| **P4 沉淀** | 共享组件(Toast/复制/DOM 助手)、Vitest 单测(元数据校验 + 路由)、README 更新 | 测试与文档 | `npm test` 全绿;新增工具全过程可在 3 步内完成 | 3–4 h |
| **P5 首个真实后端工具** | 按实际需求实现第一个 `api: true` 的工具 | 端到端可用的后端工具 | 前端 ↔ 后端类型共享生效;错误信封前端可读提示 | 视需求 |

**P1 与 P2 可并行**(共享类型文件先冻结)。

---

## 10. 测试策略

| 层级 | 工具 | 覆盖内容 |
| --- | --- | --- |
| 单元 | Vitest | `src/build/tools.ts` 的扫描与校验(各种非法 `tool.json`)、API 路由 handler(注入假 ctx)、限流器 |
| 类型 | `tsc --noEmit` | 前后端两个 tsconfig 全量检查 |
| 冒烟 | `scripts/smoke.ts` | 部署后逐个 URL 断言状态码(`/`、每个 `/tools/<slug>/`、`/tools.json`、`/api/health`),支持 `--local` / `--public` |
| 手动 | 浏览器 | 移动端排版(公众号/手机访问为主)、搜索与过滤、每个工具的交互 |

---

## 11. 风险与对策

| 风险 | 等级 | 对策 |
| --- | --- | --- |
| 内存不足导致构建 OOM(可用约 900 MB) | 中 | 限制堆 `--max-old-space-size=512`;不在机器上常驻 dev server;构建时避开日报/其它任务高峰(06:00–07:10) |
| Node 类型剥离需显式开关或不支持某些语法 | 低 | P0 验证;服务端避免 `enum`/`namespace`;生产走 esbuild 打包 |
| 引入 npm 依赖带来供应链风险 | 中 | 仅 5 个 devDeps;`package-lock.json` 入库;`npm audit`;生产零依赖 |
| 公网 API 被滥用 | 中 | §7.3 全套:限流、体积限制、SSRF 白名单、无 shell、可选 Cloudflare Access |
| **高价值凭据被公网页面公开**(DSH 登录 token = root 级入口) | **高** | §12.3:整站/该路径加 Cloudflare Access,或共享密钥,或仅限本机;禁止把 token 放进自身页面 URL |
| 中文目录名导致 URL/构建异常 | 低 | 工具目录坚持 ASCII slug(中文名放 `name`) |
| 切换期间站点不可用 | 低 | 先在同机另一端口(如 8081)起 Node 验证,再切 8080;systemd 有 `Restart=always`;保留 Python 版回滚 |
| 与现有 Python 版行为差异(如自动重建)被误当 bug | 低 | 在 README 明确:新架构用 Vite HMR(开发)+ 构建发布(生产),不再有"请求触发重建" |

---

## 12. 首个后端工具设计:DSH 登录地址(**含凭据,需先定安全方案**)

### 12.1 需求

工具箱页面上放一个按钮,点击后显示**本机正在运行的 DSH Web UI 登录地址(带 token)**,便于直接打开 / 复制。

### 12.2 凭据的真实来源(已实测确认)

| 项 | 事实 |
| --- | --- |
| token 性质 | **进程级启动令牌**:`processLaunchToken()` 用 `randomBytes` 生成,只存在于 `dsh web` 进程内存,**不落盘** |
| 有效期 | 随进程存活;`dsh web` 每次重启都会变(当前进程已连续运行 32h+) |
| 交换方式 | `GET /?token=<token>`(且 `Host` 头必须是受信 authority)→ 303 重定向 + 下发签名 cookie |
| ⚠️ 关键细节 | 直接请求 `127.0.0.1:3080`(Host=127.0.0.1:3080)会返回 **401**;必须带 `Host: dsh.zeetng.cloud` 才返回 **303** |
| 现成工具 | 服务器上已有 `/root/dsh-login-url.sh`(root 700):从 `/root/.pm2/logs/dsh-out*.log` 取**最后一条** `token=...`,用 303 校验后输出 `https://dsh.zeetng.cloud/?token=...` |
| 日志现状 | `/root/.pm2/logs/dsh-out.log`(565 B,10 行)含 5 条历史 token,**只有最后一条有效** |

**结论**:token **只能**从 pm2 启动日志里取 + 用 303 校验确认有效,没有别的可靠来源。

### 12.3 ⚠️ 安全评估(必须先决策)

该 token 交换出的 cookie 可完全登录 DSH Web UI,而 DSH 在本机以 **root** 运行、具备执行 shell 的能力
→ **这串 token 是 root 级凭据**。而 `www.zeetng.cloud` 当前是公开站点(无访问控制)。

当前之所以未直接失守,仅因为 `dsh.zeetng.cloud` 上层还有 Cloudflare Access;但把凭据明文发布到公网页面,
等于把纵深防御的第二道锁钥匙也公开了:一旦 Access 被误删/误配/绕过,攻击者可直接获得 root 级入口。
此外爬虫、截图服务、浏览器插件都可能抓到它。

三种可选防护(按强度排序):

| 方案 | 做法 | 强度 | 代价 |
| --- | --- | --- | --- |
| A. Cloudflare Access 保护该路径 | 给 `www.zeetng.cloud/api/dsh/*` 单独建一个 Access 应用(或整个站点加 Access) | 强 | 需在 Cloudflare 后台操作(现有 API token 无 Access:Edit 权限,实测 `/access/apps` 读不到应用、`/access/organizations` 返回 403) |
| **B. 共享密钥 ← 已选定** | `.env` 放 `TOOLBOX_API_KEY`,接口要求 `X-Api-Key`;密钥首次输入后存 localStorage | 中 | 密钥可能经浏览器历史/Referer 泄漏(用 `no-referrer` 缓解);换设备需重输 |
| C. 仅限本机 | 接口只在来源 IP 为 `127.0.0.1` 时返回 | 强(不暴露) | 公网页面上按钮不可用 |

**✅ 决策(已确认):采用方案 B(共享密钥)**——不动 Cloudflare 后台,由代码层守住接口。

#### 方案 B 落地细节

| 项 | 约定 |
| --- | --- |
| 密钥存放 | `.env` 的 `TOOLBOX_API_KEY`(≥32 位随机串,`chmod 600`,`.env` 不入库;`.env.example` 只放占位符) |
| 未配置时 | 接口返回 **503** 并附配置说明,**绝不放行**(fail-closed) |
| 传递方式 | 请求头 `X-Api-Key`(优先);不允许出现在 URL 查询串(避免 Referer/访问日志泄漏) |
| 比较方式 | 常量时间比较(`crypto.timingSafeEqual`),长度不等直接失败 |
| 失败响应 | 401,响应体固定文案,**不含**任何 token 片段 |
| 限流 | 该接口单独更严格:10 次/分钟/IP(失败也计数),超限 429 |
| 前端 | 首次点击弹出输入框 → 存 `localStorage['toolbox.apiKey']` → 之后自动携带;提供「更换密钥」入口 |
| 其它 | 响应 `Cache-Control: no-store`;页面 `Referrer-Policy: no-referrer`;服务端日志只记 token 前 8 位 |

无论选哪种,以下都必须做:

- token **不得**出现在工具箱页面自身的 URL 查询串里(避免 Referer/历史记录泄漏)
- 接口响应加 `Cache-Control: no-store`;页面加 `Referrer-Policy: no-referrer`
- 每次点击**实时**校验(303),不使用缓存值;失效时明确提示"token 已失效,请 `pm2 restart dsh`"
- 日志中**不打印**完整 token(只打前 8 位)

### 12.4 接口设计

```ts
// GET /api/dsh/login-url
type DshLoginUrl = {
  url: string;          // https://dsh.zeetng.cloud/?token=…
  host: string;         // dsh.zeetng.cloud
  port: number;         // 3080
  tokenPreview: string; // 前 8 位,用于人工核对
  valid: boolean;       // 303 校验是否通过
  checkedAt: string;    // ISO 时间
  source: string;       // 命中的日志文件 + 行号(便于排障)
};
```

实现要点(`server/routes/dsh.ts`):

1. 配置化(放 `.env`,不硬编码):`DSH_PUBLIC_HOST`、`DSH_PORT`、`DSH_LOG_GLOB`
2. 取 token:按 mtime 倒序遍历匹配的日志文件 → 正则 `token=([A-Za-z0-9_-]+)` → 取最后一条
3. 校验:`GET http://127.0.0.1:{port}/?token={token}`,显式设置 `Host: {DSH_PUBLIC_HOST}`,期望 **303**
4. 不跟随重定向(只取状态码),不落 cookie
5. 建议 5 秒内存缓存(避免连点触发风暴),但缓存仅存"校验结果",不影响实时性要求
6. **不通过 shell 调用 `/root/dsh-login-url.sh`**(保持 §7.3 无 shell 原则);脚本保留作为人工排障入口

### 12.5 前端交互(纯 TS + 原生 DOM)

```
[ 显示 DSH 登录地址 ]        ← 初始只有按钮

点击后:
  ✅ 有效  https://dsh.zeetng.cloud/?token=XXXX…（完整值）   [复制] [打开]
     校验于 21:05:33 · 来源 dsh-out.log:10
  ❌ 失效  红色提示:token 已失效(HTTP 401),请执行 pm2 restart dsh
```

- 完整地址放只读 `<input>` 或 `<textarea>`,便于全选复制;默认用 `••••` 遮蔽,点「显示」才展开
- `target="_blank" rel="noopener noreferrer"`(带 `noreferrer` 防止 Referer 带出地址)
- 复制失败降级:选中文本 + 提示手动复制

### 12.6 验收标准

1. 点击按钮 3 秒内返回地址;`curl -H "Host: dsh.zeetng.cloud" "http://127.0.0.1:3080/?token=…"` 返回 303
2. `pm2 restart dsh` 后再次点击,返回**新** token(验证不是缓存)
3. 未授权访问(未过 Access / 未带密钥)时接口返回 401,且响应体**不含**任何 token 片段
4. 服务端日志中不出现完整 token
5. 站点其余公开页面不受影响(若采用方案 A,确认 Access 只作用于约定路径)

---

## 13. 待确认事项(实施前需拍板)

1. ~~**DSH 地址工具的安全方案**~~ → **已定:方案 B(共享密钥)**,详见 §12.3。
2. ~~**实现时机**~~ → **已定:随 TypeScript 版一起做**(作为首个 `api: true` 的后端工具,对应 P5)。
3. **首批后端工具清单**:除 DSH 地址外还有哪些工具要后端能力,决定其余 `/api/*` 路由与出网白名单。
4. **是否给写操作加 Cloudflare Access 保护**(只靠限流是否足够)。
5. **Python 版保留策略**:建议保留至新架构稳定运行一周后再删。
6. **仓库策略**:本工程目前尚未纳入 git;建议先 `git init` 并推私有仓库,再做 P1,便于分阶段回滚。
7. **Node 版本策略**:跟随机器现有 v22;是否加 `.nvmrc` / `engines` 约束(建议加 `engines: { node: ">=22" }`)。

---

## 14. 实施记录

### P0 环境验证(已完成)

| 项 | 结果 |
| --- | --- |
| npm 安装 | `npm install --save-dev` **11 秒**、43 个包、`node_modules` 83 MB |
| 依赖版本 | TypeScript **7.0.2**、Vite **8.3.0**、esbuild 0.28.2、Vitest 5.0.0、@types/node 26.5.1、happy-dom 20.14.5 |
| Node 类型剥离 | ✅ 免参数可用(`node script.ts` 直接跑,Node 22.23) |
| `vite build` | **0.1 秒**(14 modules),内存无压力 |
| `vitest run` | 2.2 秒(21 个用例) |
| 结论 | 内存/网络/磁盘均无瓶颈,原计划的"避开 06:00–07:10 日报高峰"非必需,但保留为好 |

### P1 前端骨架(已完成)

交付内容:

- 工程配置:`package.json`、`tsconfig.json`、`vite.config.ts`、`env.d.ts`
- 构建管线:`src/build/tools.ts`(扫描 + 元数据校验)、`src/build/tools-plugin.ts`(`virtual:tools`、`virtual:site`、`dist/tools.json`、vanilla 拷贝)
- 前端:门户页(`src/hub`)、共享层(`src/shared`:types / dom / toast / clipboard / base.css)
- 工具:一次 **TS 迁移示例**(`tools/timestamp`,含 `main.ts`)+ 一个 **vanilla 示例**(`tools/json-format`,验证两种入口共存)
- 测试:`tests/tools.test.ts`(15 个,覆盖全部非法元数据)、`tests/hub.test.ts`(6 个,happy-dom 真实渲染 + 搜索 + 标签过滤)

验收实测:

| 验收项 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过(含 tests) |
| `npm test` | 21/21 通过 |
| `npm run build` | 0.1 秒;产物含门户页、TS 工具编译产物、vanilla 工具拷贝、`tools.json` |
| 预览(8081) | `/`、`/tools/timestamp/`、`/tools/json-format/`、`/tools.json`、`/assets/base.css` 全部 200 |
| 构建期注入 | 门户 bundle 中确认内联了工具清单(无需运行时接口) |
| 线上回归 | `https://www.zeetng.cloud` 仍由 Python 版正常服务(未受影响) |

### 与原计划的偏差(及原因)

| 偏差 | 原因 |
| --- | --- |
| devDeps 由 5 个增至 **6 个**(多 happy-dom) | 门户卡片是运行时渲染,必须有 DOM 测试兜底,否则选择器写错会静默渲染空白页 |
| 暂用**单个 tsconfig**(`types: ["vite/client", "node"]`) | P1 需要同时编译 `vite.config.ts` / `src/build/**`(Node) 与前端;待 P2 服务端成型后再拆 `tsconfig.server.json` |
| 配置图内改用**显式 `.ts` 扩展名** + `allowImportingTsExtensions` | Vite 8 的 native config loader 要求;不修会有告警,未来会成为默认行为 |
| 新增 **Python 版迁移守卫**(`registry.py` 跳过含 `main.ts` 的工具) | 原计划未考虑:两个构建管线共用 `tools/`,Python 版无法编译 TS,会把坏页面拷进 `public/` |
| 为 vanilla 工具额外输出 `/assets/base.css` | TS 构建的样式是带哈希的资源,vanilla 工具通过稳定路径引用共享样式(全部迁移后可删) |

### 过程中的一个真实教训

Python 服务是**长驻进程,不会热加载代码**:修改 `registry.py` 的守卫后,正在运行的服务仍用旧逻辑
构建了含 TS 工具的 `public/`,导致线上 `/tools/timestamp/` 一度把 `main.ts` 当静态文件返回
(`Content-Type: application/octet-stream`),浏览器拒绝执行 → 页面失效。

**规范**:改动 Python 版任何代码后,必须 `systemctl restart aggregation-page` 再验证。

### 下一步(P2)

1. `server/` 全套:静态托管(路径穿越防护 / ETag / 分级缓存)、`/api` 分发、限流、安全响应头
2. `scripts/dev.ts`(同时起 Vite 与 Node)、`scripts/build-server.ts`(esbuild 打包)、`scripts/smoke.ts`
3. 在 8081 端口并跑对比,验收后把 systemd 的 `ExecStart` 切到 Node

---

## 15. P2 实施记录(Node 服务层)

### 交付内容

| 文件 | 职责 |
| --- | --- |
| `server/index.ts` | 入口:读环境 → 校验 `dist/` → 组装 → 监听 → 信号处理 |
| `server/app.ts` | HTTP 组装(与入口分离,便于单测直接起临时端口) |
| `server/static.ts` | 静态托管:路径穿越防护、目录补 index、分级缓存、ETag/304、流式响应 |
| `server/api.ts` | `/api` 分发:统一信封、64KB 体积上限、10s 超时、错误映射 |
| `server/security.ts` | 安全响应头、固定窗口限流、真实 IP(`CF-Connecting-IP`) |
| `server/log.ts` | JSON lines 日志(含每请求 id/耗时/状态/IP) |
| `server/env.ts` | `.env` 解析(不引入 dotenv)+ 配置校验回退 |
| `server/routes/*` | 显式路由注册表:`/api/health`、`/api/tools`、`/api/echo` |
| `scripts/dev.ts` | 双进程开发:Vite(5173)+ Node API(8090),`/api` 走代理 |
| `scripts/build-server.ts` | esbuild 打包 → `dist-server/index.js`(零运行时依赖) |
| `scripts/smoke.ts` | 冒烟:14 项状态码断言,支持 `--port` / `--public` |
| `.env.example` | HOST/PORT/LOG_LEVEL/API_RATE_LIMIT/TOOLBOX_API_KEY |

### 验收实测(全部通过)

| 项 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | **42/42**(新增服务端 21 个:路径解析、响应头策略、限流、环境变量、HTTP 集成) |
| `npm run build` | 131ms(前端 86ms + 服务端 7ms);`dist-server/index.js` 17.8KB |
| `npm run smoke --port 8081` | **14/14** |
| 安全头 | nosniff / no-referrer / DENY / Permissions-Policy / CSP 全部就位 |
| 缓存分级 | `/assets/*` → `immutable`;`/tools.json`、`/` → `no-cache` |
| ETag | 命中 `If-None-Match` 返回 **304** |
| 限流 | 连续 70 次 `/api/health` → 52 次 200、18 次 **429**(带 `Retry-After`);静态资源不受影响 |
| 体积上限 | 70KB 请求体 → **413** |
| 目录穿越 | `/../package.json` → 404(URL 归一化);`/%2e%2e%2fpackage.json` → **403** |
| 优雅退出 | `SIGTERM` → 日志记录 → 退出码 0 |
| 开发模式 | Vite 5173 页面 200;API 8090 直连与经代理均返回 `{"ok":true,...}` |
| 线上回归 | `https://www.zeetng.cloud` 仍由 Python 版正常服务,未受影响 |

### 过程中的两个真实问题

**1. Node 类型剥离不支持构造器参数属性(P0 预警过,确实踩到)**

`server/api.ts` 用了 `constructor(readonly status: number, ...)`,开发模式下
`node --watch server/index.ts` 直接报 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`,
API 进程起不来(Vite 代理报 ECONNREFUSED)。`RateLimiter` 有同样问题。

- 修法:改为显式字段声明 + 赋值
- 规范:`server/`、`scripts/` 及所有以 `.ts` 直接运行的代码,**禁用**参数属性、`enum`、`namespace`
- 自查命令:
  ```bash
  grep -rnE "constructor\(|^\s*(private|public|protected|readonly)\s+\w+\s*[:,)]" server scripts src --include="*.ts"
  ```
- 生产构建不受影响(esbuild 会正常编译),所以**只有开发模式会暴露** —— 这也是必须实测 `npm run dev` 的原因

**2. 单测抓到 `%00` 绕过 NUL 检查**

`resolveWithin` 原本在**解码前**检查 `\0`,而 `%00` 解码后才产生 NUL 字符,检查被绕过
(实际危害有限:Node 的 fs 会因路径含 NUL 抛错 → 落到 404,但检查本身不完整)。
已改为解码后再查一次,并补了 `/a%00b → 403` 的冒烟用例。

### 偏差

| 偏差 | 原因 |
| --- | --- |
| 拆分出 `server/app.ts` | 入口若直接 listen 则无法在测试里起临时端口;拆分后集成测试可离线跑 |
| 多加一个 `/api/echo` 示例接口 | 让 API 骨架的分支(405/415/400/413)能被测试与冒烟覆盖 |
| CSP 暂留 `'unsafe-inline'` | vanilla 工具仍有内联脚本;全部迁移为 TS 后可收紧 |
| 未做 Range 请求 | 当前资源都是小文件,收益为零;需要时再补 |

### 下一步(P3:切换上线)

1. 在 8081 端口并跑:Node 服务与 Python 版逐项对比(页面、`tools.json`、接口)
2. `deploy/aggregation-page.service` 已改为 `ExecStart=/usr/bin/node dist-server/index.js`;
   切换 = `cp` 单元文件 + `daemon-reload` + `restart` + `enable`
3. 切换后跑 `npm run smoke -- --public`,并确认 Cloudflare 侧缓存与安全头表现
4. 保留 Python 单元(`aggregation-page-python`)一周,作为回滚路径

### 待办(P5 需要的准备)

- `TOOLBOX_API_KEY` 已进 `.env.example`,但**校验中间件尚未实现**(P5 实现 DSH 地址工具时一起加)

---

## 16. P3 实施记录(上线切换)

### 切换动作

```bash
# 1. 保留 Python 单元作为回滚路径(不 enable,不会开机自启)
#    /etc/systemd/system/aggregation-page-python.service
# 2. 换成 Node 单元
cp deploy/aggregation-page.service /etc/systemd/system/aggregation-page.service
systemctl daemon-reload && systemctl restart aggregation-page
```

切换前后基线:

| 项 | 切换前(Python) | 切换后(Node) |
| --- | --- | --- |
| 进程 | `python3 serve.py` | `node dist-server/index.js` |
| `/tools.json` count | 1(TS 工具被守卫跳过) | **2**(两个工具都在) |
| `/tools/timestamp/` | 404 | **200** |
| 内存 | 11.4 MB | **16 MB**(`MemoryMax=384M`) |
| 启动 | 秒级 | 秒级 |

### 验收实测

| 项 | 结果 |
| --- | --- |
| 本地冒烟(8080) | **14/14** |
| 线上冒烟(经 Cloudflare) | **14/14** |
| 线上 `/api/health` | `{"ok":true,...,"tools":2}` |
| 线上安全头 | CSP / nosniff / no-referrer 全部保留 |
| Cloudflare 缓存 | `cf-cache-status: DYNAMIC`(符合 `no-cache` 预期) |
| 中断时长 | 约 1–2 秒(restart 期间) |

### 发现:目录穿越在边缘就被拦掉

`/%2e%2e%2fpackage.json` 的实测表现:

| 链路 | 状态码 | 说明 |
| --- | --- | --- |
| 直连源站 8080 | **403** | `resolveWithin` 判定越界 |
| 经 Cloudflare | **400**(无 `cf-ray`) | **边缘先拦下,请求根本没到源站** |

这是纵深防御的正常结果,不是缺陷。冒烟脚本因此支持"多个可接受状态码"
(`expect: [403, 400]`),并注明原因。

### 回滚方法(保留一周)

```bash
sudo systemctl stop aggregation-page
sudo systemctl start aggregation-page-python
```

稳定运行一周后清理:删除 `aggregation-page-python.service`、删除 Python 实现
(`build.py` / `serve.py` / `aggregation_page/`)、删除 `public/`。

### 下一步(P5:DSH 登录地址工具)

前置条件已全部就绪(§12 已定义接口、密钥约定;`/api` 骨架与鉴权位置已留好)。实现内容:

1. `server/security.ts` 增加 `requireApiKey()`(常量时间比较;密钥未配置 → 503)
2. `server/routes/dsh.ts`:`GET /api/dsh/login-url` —— 取 pm2 日志最后一条 token → 带
   `Host: dsh.zeetng.cloud` 做 303 校验 → 返回地址;5 秒校验结果缓存;日志只打前 8 位
3. `tools/dsh-url/`:按钮 + 密钥输入(localStorage)+ 复制/打开 + 失效提示
4. 测试:密钥校验分支、日志解析、303 校验(打桩)、前端渲染
