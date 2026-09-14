# aggregation-page · 在线工具箱

把日常用得到的小工具集中放在一个页面上的**自托管工具箱**。

- 门户页(`/`)自动列出全部工具,支持搜索与标签过滤
- 每个工具是 `tools/<slug>/` 下的一个页面,**新增工具不用改门户**
- 构建产物是纯静态文件(`dist/`),可选配一个 Node 后端提供 `/api/*`
- 通过 **Cloudflare 隧道**发布到 `https://www.zeetng.cloud`,无需开放公网端口、无需 ICP 备案

> 当前状态:正在从 Python 实现迁移到 **TypeScript + Vite**(见 `docs/ts-rewrite-plan.md`)。
> Python 版保留作为回滚,详见文末「迁移状态」。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 语言 | TypeScript(strict,`noUncheckedIndexedAccess`) |
| 前端 | 原生 DOM(无 UI 框架) |
| 构建 | Vite 8(多页应用 MPA) |
| 服务端 | 计划中:Node 单文件服务(静态 + `/api/*`) |
| 测试 | Vitest + happy-dom |
| 包管理 | npm(registry 已指向 npmmirror) |

## 目录结构

```
aggregation-page/
├── package.json / tsconfig.json / vite.config.ts / .env.example
├── index.html                    # 门户页入口
├── src/
│   ├── hub/                      # 门户:卡片渲染、搜索、标签过滤
│   ├── shared/                   # 前后端共享:types / api 信封 / dom / toast / clipboard / base.css
│   └── build/                    # 构建期:扫描 tools/、virtual:tools、tools.json
├── server/                       # Node 服务端(零运行时依赖)
│   ├── index.ts                  #   入口:环境、校验 dist、监听、信号
│   ├── app.ts                    #   HTTP 组装(便于单测)
│   ├── static.ts                 #   静态托管:路径穿越防护 / ETag / 分级缓存
│   ├── api.ts                    #   /api 分发:信封、体积上限、超时
│   ├── security.ts               #   安全头、限流、真实 IP
│   ├── log.ts                    #   JSON lines 日志
│   └── routes/                   #   接口注册表(显式列出,便于审查)
├── scripts/                      # dev(双进程)/ build-server(esbuild)/ smoke
├── tools/                        # 一个目录一个工具
│   ├── timestamp/                #   TS 工具:index.html + main.ts + style.css
│   └── json-format/              #   vanilla 工具(渐进迁移中,原样拷贝)
├── tests/                        # Vitest:工具校验 / 门户渲染 / 服务端
├── dist/  dist-server/           # 构建产物(gitignore)
├── public/                       # Python 版的产物(gitignore,迁移期保留)
├── deploy/                       # systemd 单元
└── docs/ts-rewrite-plan.md       # 架构与实施方案
```

## 常用命令

```bash
npm install            # 首次
npm run dev            # 开发模式:Vite(5173)+ Node API(8090),/api 走代理
npm run build          # 构建前端(dist/)+ 服务端(dist-server/)
npm start              # 启动服务端(需先 build;默认 127.0.0.1:8080)
npm run preview        # 只看前端产物 http://127.0.0.1:8081
npm run typecheck      # tsc 全量类型检查
npm test               # Vitest(42 个用例)
npm run smoke          # 冒烟:逐个 URL 断言状态码(--public 打线上)
```

实测:构建 **0.13 秒**(前端 0.09s + 服务端 0.01s),42 个测试约 **3 秒**,14 项冒烟约 0.2 秒。

开发期 API 端口是 **8090**,避开仍在运行的 Python 版(8080);正式上线时 Node 监听 8080。

## 新增一个工具

### 方式一:TypeScript 工具(推荐)

```bash
mkdir tools/my-tool
```

`tools/my-tool/tool.json`:

```json
{ "name": "我的工具", "description": "一句话说明", "tags": ["开发"], "icon": "🧰" }
```

`tools/my-tool/index.html`(只写结构,样式与逻辑在 TS 里):

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>我的工具 · 在线工具箱</title></head>
<body>
<header class="site-head"><div class="inner">
  <a class="brand" href="/">← 在线工具箱</a>
  <p class="tagline">🧰 我的工具</p>
</div></header>
<main class="wrap"><section class="card"><h2>功能</h2><div id="app"></div></section></main>
<script type="module" src="./main.ts"></script>
</body>
</html>
```

`tools/my-tool/main.ts`:

```ts
import '../../src/shared/base.css';
import { must } from '../../src/shared/dom';
import { toast } from '../../src/shared/toast';

must('#app').textContent = 'Hello';
toast('工具已加载');
```

### 方式二:沿用旧写法(vanilla)

只放 `tool.json` + 自包含的 `index.html`(不建 `main.ts`)。构建时会**整目录原样拷贝**,
可选择性引入 `/assets/base.css` 复用站点配色。

> 目录名必须是 ASCII 小写字母/数字/连字符(URL 片段就是它);中文名写在 `name` 字段。
> 元数据不合法会**直接让构建失败**,避免上线坏卡片。

## 后端接口

单进程同时托管静态文件与 `/api/*`,响应统一信封(类型见 `src/shared/types.ts`):

```jsonc
// 成功
{ "ok": true,  "data": { ... } }
// 失败
{ "ok": false, "error": { "code": "rate_limited", "message": "请求过于频繁,请稍后再试" } }
```

内置接口:

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 存活探针:版本、运行时长、工具数量 |
| GET | `/api/tools` | 工具清单(读 `dist/tools.json`,带 mtime 缓存) |
| POST | `/api/echo` | 回显请求体(用于验证 JSON/体积/方法/超时各分支) |

新增接口:在 `server/routes/` 建文件导出工厂函数 → 在 `server/routes/index.ts` **显式注册** →
共享类型补到 `src/shared/types.ts`。注册表是显式的,审查看一眼就知道暴露了什么。

接口层统一行为:`/api/*` 每 IP 60 次/分钟(超限 429 + `Retry-After`)、请求体上限 64KB(超限 413)、
单请求 10 秒超时(504)、响应 `Cache-Control: no-store`。

## 部署

```
访客 → Cloudflare 边缘(自动 HTTPS)→ cloudflared 隧道 → 本机 127.0.0.1:8080(Node:静态 + /api)
```

```bash
# 构建 + 重启服务
npm run build
sudo systemctl restart aggregation-page

# 冒烟(本机或线上)
npm run smoke -- --port 8080
npm run smoke -- --public

# 隧道配置在 /etc/cloudflared/config.yml,无需开端口/备案
```

生产服务只依赖 Node 内置模块:`dist-server/index.js` 是 esbuild 打出的单文件,无 `node_modules`。
单元文件见 `deploy/aggregation-page.service`(`MemoryMax=384M`,`Restart=always`,
可选读取项目根目录的 `.env`)。

## 安全约定(后端工具必读)

站点经隧道对公网开放,因此 `/api/*` 一律按公网可达设计:

- 密钥只放 `.env`(600 权限,不入库),**不得**进入前端 bundle
- 需要凭据的接口用共享密钥(`X-Api-Key`),**未配置密钥时返回 503 而不是放行**
- 不接受任意文件路径、不执行 shell、外部请求域名写死白名单(防 SSRF)
- 所有 `/api/*` 限流(默认 60 次/分钟/IP);静态资源不受影响
- 安全响应头:`nosniff` / `Referrer-Policy: no-referrer` / `X-Frame-Options: DENY` / CSP
  (CSP 目前保留 `'unsafe-inline'`,因为 vanilla 工具还有内联脚本;全部迁移为 TS 后应移除)
- 路径穿越双重防护:URL 归一化 + `resolveWithin` 前缀校验(含 `%00` 解码后再查一次)

## 迁移状态(与 Python 版的关系)

| 部分 | Python 版 | TypeScript 版 |
| --- | --- | --- |
| 门户页 | `build.py` + `aggregation_page/render.py` | ✅ `src/hub` + Vite |
| 工具构建 | 整目录拷贝 | ✅ TS 工具编译 + vanilla 拷贝 |
| 工具元数据 | `registry.py` | ✅ `src/build/tools.ts`(带校验) |
| 静态服务 | `serve.py`(systemd 当前在用) | ✅ `server/`(已在 8081 验证,待 P3 切换) |
| 后端接口 | 无 | ✅ `/api/health`、`/api/tools`、`/api/echo` |

迁移期约定:

- **带 `main.ts` 的工具由 TS 版构建**,Python 版会自动跳过(见 `registry.py` 的守卫),
  避免产出无法执行的页面
- 线上仍由 Python 版服务 `public/`;TS 版构建到 `dist/`,在 8081/8090 验证后再切到 8080(P3)
- 全部切换稳定运行一周后,可删除 Python 实现(`build.py`、`serve.py`、`aggregation_page/`)

## 文档

- `docs/ts-rewrite-plan.md` —— 架构、接口设计、分阶段实施计划、风险与决策记录
