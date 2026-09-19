---
name: add-tool
description: 在 aggregation-page「在线工具箱」(https://www.zeetng.cloud) 新增一个工具页面,或为工具新增后端 API 接口。涵盖 tools/ 目录约定、tool.json 校验规则、TS/vanilla 两种写法、密钥与安全约定、长耗时接口的后台任务与轮询写法、以及各工具的参考实现对照。
whenToUse: 当用户要求在「在线工具箱」或 aggregation-page 项目里加一个工具、加一个 /api 接口、或修改 tools/ 下已有工具时使用。
---

# 新增工具(aggregation-page)

项目根:`/root/dshworkspace/aggregation-page`
线上:https://www.zeetng.cloud(Cloudflare 隧道 → 本机 127.0.0.1:8080)

> 📌 **动手前先看 §11「参考实现」** —— 按你要做的东西挑一个现有工具抄,比自己从零想快得多。
>
> **贯穿全程的硬约束:运行时依赖必须保持为零。**
> `package.json` 里 `dependencies` 不存在,只有 `devDependencies`。
> 生产 `dist-server/index.js` 是 esbuild 打出的单文件,靠 Node 内置模块运行。
> 不要为了一个工具引入 npm 运行时包;需要功能就自己写或用 Web API。

## 1. 先确认需求,缺信息就问

至少要问清这 5 项,别自己猜:

| 项 | 说明 |
| --- | --- |
| 做什么 | 一句话功能描述(`description`) |
| 名称 | 中文显示名(`name`),如「JSON 格式化」 |
| slug | 目录名 / URL 片段,只能 `[a-z0-9-]`,1–40 位,如 `dsh-url` |
| 纯前端还是需要后端 | 决定 TS 还是 vanilla、要不要写路由 |
| 是否需要密钥 | 涉及 token、本机操作、写操作 → 需要 |

`tags`(如 `["开发","文本"]`)、`icon`(单个 emoji)、`order` 可自行拟定后告知用户。

## 2. 选类型:三种情况

| 情况 | 写法 | 必需文件 |
| --- | --- | --- |
| **纯前端逻辑**(推荐) | TS 工具 | `tool.json` `index.html` `main.ts` `style.css` |
| 老式自包含页面 | vanilla 工具 | `tool.json` `index.html`(无 `main.ts`) |
| **需要后端** | **必须 TS** | 同上 + `server/routes/` 新路由 |

判据就是目录里**有没有 `main.ts`**:

- **有** → 走 Vite 编译(TS、可 import 共享模块)
- **无** → 整个目录**原样拷贝**到 `dist/`

> ⚠️ vanilla 工具**不能**声明 `"api": true`,否则构建直接失败(`scanTools` 会抛
> `ToolConfigError`)。需要后端就必须改成 TS 工具。

## 3. 写元数据 `tool.json`

```json
{
  "name": "我的工具",
  "description": "一句话说明这个工具做什么。",
  "tags": ["开发"],
  "icon": "🧰",
  "status": "ready",
  "order": 100
}
```

校验规则(违反 → **构建失败**,这是有意设计的"宁可构建失败也不上线坏卡片"):

| 字段 | 规则 |
| --- | --- |
| `name` | **必填**,非空字符串。中文名写这里 |
| `description` | 可选,字符串,自动 trim |
| `tags` | 可选,**字符串数组**(非数组或含非字符串 → 失败);空串会被过滤掉 |
| `icon` | 可选,默认 `🧰` |
| `status` | 可选,只能是 `"ready"` 或 `"wip"`,默认 `ready` |
| `order` | 可选,**整数**,默认 `100`。**小的排前面** |
| `api` | 可选,只有 `true` 才写入;表示该工具有后端接口 |
| `hidden` | 可选,`true` 则**不进门户卡片**,也不出现在 `/tools.json`(`count` 与列表都只统计可见工具) |

目录名(slug)必须匹配 `/^[a-z0-9][a-z0-9-]{0,39}$/`。
**中文名一律写 `name`,不要用在目录名上**。以 `.` 或 `_` 开头的目录被跳过。

现有 `order` 参考:`dsh-url`=5、`dsh-restart`=6、`timestamp`=10、`json-format`=20。
新工具一般取 30 或 100。

## 4. 写页面

### TS 工具(推荐)

`index.html` —— **只写结构**,不写 `<style>`,用相对路径引 `main.ts`:

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>我的工具 · 在线工具箱</title>
</head>
<body>
<header class="site-head"><div class="inner">
  <a class="brand" href="/">← 在线工具箱</a>
  <p class="tagline">🧰 我的工具</p>
</div></header>
<main class="wrap">
  <section class="card">
    <h2>功能</h2>
    <div id="app"></div>
  </section>
</main>
<script type="module" src="./main.ts"></script>
</body>
</html>
```

`main.ts` —— **样式从 TS 里 import**(不要用 `<link>`):

```ts
import '../../src/shared/base.css';
import './style.css';

import { must } from '../../src/shared/dom';
import { toast } from '../../src/shared/toast';

must('#app').textContent = 'Hello';
toast('工具已加载');
```

`style.css` —— **只写本工具特有样式**,通用部分已在 `base.css`:

```css
/* 通用组件(卡片/按钮/输入框/提示条)在 src/shared/base.css */
.row > input { flex: 1 1 220px; }
```

### vanilla 工具

只放 `tool.json` + 自包含 `index.html`:**样式内联在 `<style>`**,用
`<link rel="stylesheet" href="/assets/base.css">` 复用站点配色(该路径由构建插件专门输出),
逻辑内联在 `<script>`。可直接参考 `tools/json-format/`。

> vanilla 只是为兼容旧页面保留的路径;新工具除非用户明确要求,一律用 TS。

## 5. 复用共享模块(别重复造)

| 模块 | 提供 |
| --- | --- |
| `src/shared/base.css` | 设计令牌(`--ink` `--muted` `--line` `--card` `--accent`)、极光背景、`.card` `.site-head` `.wrap` `.row` `.hint` `.out` `.warn/.ok/.err` `.toast` |
| `src/shared/dom.ts` | `must<T>()`(取元素,缺了直接抛错)、`el`、`fill`、`debounce` |
| `src/shared/toast.ts` | `toast(msg)` |
| `src/shared/clipboard.ts` | `copyText(text)` |
| `src/shared/api.ts` | `callApi<T>(path, { method, body, apiKey, signal })`、`ApiError{status,code}` |
| `src/shared/types.ts` | 前后端共用类型 |

**页面结构保持一致**:顶部 `header.site-head`(返回门户 + 工具名),主体 `main.wrap` 内若干 `section.card`。
站点是**纯暗色主题**,不要写浅色适配。

## 6. 需要后端时

在 `server/routes/` 新建 `xxx.ts`,导出返回 `Route` 的工厂函数,**然后在
`server/routes/index.ts` 里显式注册**(那里是手工维护的清单,不做目录扫描 —— 为的是一眼看清全站暴露了什么)。

步骤:

1. `server/routes/xxx.ts` —— 导出 `xxxRoute(deps)`,内部用 `Route{ method, path, auth?, handle }`
2. `server/routes/index.ts` —— import 并加进 `buildRoutes()` 返回的数组
3. `src/shared/types.ts` —— 补请求/响应类型(前后端共用)
4. 同步更新 `server/routes/index.ts` 顶部的**接口一览注释**和 README 的接口表

约定:

- 响应统一信封 `{ ok: true, data }` / `{ ok: false, error: { code, message } }`
- 业务错误抛 `ApiError(status, code, message, retryAfterSeconds?)`
- **需要密钥** → `auth: true`(路由器会先限流、再过失败预算、再校验密钥)
- **有副作用** → 必须再加**冷却**(参考 `server/routes/dsh-restart.ts` 的 60 秒冷却)
- 接口层已统一处理:`/api/*` 每 IP 60 次/分钟(429 + `Retry-After`)、请求体 64KB 上限(413)、
  10 秒超时(504)、响应 `Cache-Control: no-store`

### ⚠️ 10 秒是硬上限:超过就必须做成"后台任务 + 轮询"

接口层对所有 `/api` 请求有**一条统一的 10 秒超时**。任何可能超过 10 秒的活儿
(npm/pip 安装、抓取慢站点、等某个进程重启…)**不能同步返回** —— 逻辑再正确也会被接口层 504。

做法(照抄 `server/routes/dsh-update.ts`):

- `POST` 只**启动**任务并立即返回;任务状态(步骤列表 + `running|ok|failed`)存内存
- `GET` 返回该状态,前端轮询渲染进度
- 给 deps 留**可注入的超时/间隔**参数,否则单测要真等几十秒(没法用)

#### 轮询间隔必须拿额度反算(这条踩过两次)

`auth: true` 的接口走**独立限流**(`.env` 的 `AUTH_RATE_LIMIT`,当前 30/分钟)。
**轮询会持续吃这个额度**,间隔太小就会在关键节点被 429 挡住。必须满足:

```
固定请求数 + ⌈总超时 / 轮询间隔⌉ ≤ AUTH_RATE_LIMIT
```

真实事故:重启工具以 1.2 秒轮询 `/api/dsh/login-url`,而当时 `AUTH_RATE_LIMIT=5`
—— 额度在 5.5 秒耗尽,而 dsh 要 8.6 秒才打印新 token,**每次点都必然超时**。

配套三条规矩:

- 轮询的 `catch` **不能一律吞掉**:要识别 `rate_limited` / `auth_locked` 并**退避更久**
- 前端与测试**都不许写死毫秒等待**,从常量推导(否则调间隔就把测试写挂)
- 常量抽到独立模块(如 `tools/<slug>/polling.ts`):`main.ts` 顶层要取 DOM,
  单测直接 import 会炸;独立后单测才能守住上面那个不等式

## 7. 安全约定(**后端工具必读**)

站点经隧道**对公网开放**,一律按公网可达设计:

- 密钥只放 `.env`(600 权限,不入库),**绝不允许进前端 bundle**
- 未配置密钥时**返回 503 而不是放行**(fail-closed)
- 不接受任意文件路径、**不执行 shell**、外部请求域名写死白名单(防 SSRF)
- 后端执行外部命令时用 `execFile` 传**常量参数数组**,不经 shell、不拼用户输入
- ⚠️ **token / 密钥绝不能出现在页面 URL 里**(会被 Referrer、历史记录、日志带出去)。
  站点已设 `Referrer-Policy: no-referrer`,接口响应 `Cache-Control: no-store`

### 密钥策略(用户明确要求,不要"优化"掉)

- 密钥固定为 **`521016`**(在 `.env` 的 `TOOLBOX_API_KEY`)
- **每次操作都要用户重新输入**,不做任何保存 ——
  **禁止** `localStorage` / `sessionStorage` / cookie / `IndexedDB`
- 只通过 **`X-Api-Key` 请求头**发送,**不要**放 query string
- 输入框用 `type="password"`,并关掉 `autocomplete` / `autocapitalize` / `spellcheck`
- 敏感结果(如含 token 的地址)**默认打码**,提供「显示」按钮

## 8. 验证(每步都要跑,别跳)

```bash
cd /root/dshworkspace/aggregation-page

npm run typecheck          # TS 严格模式
npm test                   # 必须全绿;新增用例后总数会变,但不许改既有断言来"凑绿"
npm run build              # 构建期校验 tool.json,不合法会在这里失败
sudo systemctl restart aggregation-page
npm run smoke -- --port 8080    # 本机冒烟
npm run smoke -- --public       # 线上冒烟
```

补充要求:

- 纯前端工具的逻辑**要补单测**;DOM 相关的测试文件顶部必须加 `// @vitest-environment happy-dom`
- `tests/hub.test.ts` 的期望值是从 `tools/` **动态推导**的,新增工具**不需要改它**
- **改了 `RouteDeps` / `AppOptions` 后,必须同步所有测试 harness 里的桩构造** ——
  `tests/{server,dsh,dsh-restart,news}.test.ts` 各有一份,漏掉就会在 typecheck 时
  一次性报一堆"缺字段"(加**一个**依赖会牵动 4 个文件)。桩一律用惰性值
  (`'/nonexistent/xxx'` + `run: async () => ...`),保证测试永不执行真实命令
- **新接口要补冒烟断言**(`scripts/smoke.ts`):受保护接口写成 `[401, 429]` 而**不是**死写 401 ——
  冒烟一次会连打多个鉴权接口,连跑两遍就会撞限流,死写 401 会变成假失败
- 写轮询相关的测试时,**给测试用的 app 放宽 `authRateLimit`**:测试轮询很密
  (几十毫秒一次),否则会被限流打满,报出一堆看不懂的 `undefined` 错误
- Node 22 的 TS 剥离模式**不支持** `enum` / `namespace` / 构造器参数属性
  (`constructor(readonly x: number)`),`server/` 下被 node 直接执行的 `.ts` 尤其注意
- 所有 TS import **必须带 `.ts` 后缀**(`allowImportingTsExtensions`)
- 最后一个 vanilla 工具迁移完之前,`/assets/base.css` 兼容输出不能删

## 9. 收尾

1. **README 要同步**:工具清单、接口表、工具数量、测试数量
   (`README.md` 的「新增一个工具」「后端接口」章节)
2. 结构性改动补 `docs/ts-rewrite-plan.md`(按 §编号追加实施记录)
3. 提交并推送:

```bash
git add -A
git commit -m "新增工具「我的工具」"     # 中文、说明做了什么
git push                                 # git@github.com:ZeeTee/aggregation-page.git (main)
```

## 10. 完成前自查

- [ ] `tool.json` 字段合法,slug 是 ASCII 小写/数字/连字符
- [ ] TS 工具:`main.ts` 里 import 了 `base.css` 和 `style.css`;`index.html` 无内联 `<style>`
- [ ] vanilla 工具:没有 `main.ts`,也没有 `api: true`
- [ ] 没有新增运行时依赖
- [ ] 密钥没有被持久化,也没出现在 URL 里
- [ ] 有副作用的接口带冷却;需要凭据的接口标了 `auth: true`
- [ ] 若接口可能超过 10 秒:已改成**后台任务 + 轮询**,且轮询间隔用 `AUTH_RATE_LIMIT` 反算过
- [ ] 若改过 `RouteDeps` / `AppOptions`:4 个测试 harness 的桩都同步了
- [ ] typecheck / test / build / smoke 全过
- [ ] 已 `systemctl restart`,线上 URL 能打开
- [ ] README 与提交推送都完成

## 11. 参考实现(动手前先挑一个抄)

现有工具就是最好的模板。按"你要做的东西"挑:

| 你要做的 | 抄这个 | 它示范了什么 |
| --- | --- | --- |
| 纯前端小工具 | `tools/timestamp/` | TS 工具最小形态、共享模块用法 |
| 自包含老式页面 | `tools/json-format/` | vanilla 写法、`/assets/base.css` |
| 读一个本机敏感值 | `tools/dsh-url/` | 密钥校验、**默认打码 + 显示按钮** |
| **有副作用**的操作 | `tools/dsh-restart/` | 二次确认、冷却、取消即丢弃密钥、进度步骤 |
| **调用另一个项目** | `tools/manual-news/` | 跨项目:execFile 调对方 CLI 读 JSON |
| **耗时超过 10 秒** | `tools/dsh-update/` | **后台任务 + 轮询**、失败时中止后续步骤、回滚 |

### 从 `dsh-update` 抄的几条通用经验

- **危险操作要把"自救入口"放在 dsh 之外**:它更新 dsh 本身,而 dsh 挂了就打不开 dsh 的任何页面
  —— 所以回滚做在工具站(独立服务),用户不必 SSH 就能救回来。做"会弄挂别的东西"的工具时,
  先想清楚:**出事之后,用户从哪里点回来?**
- **一失败就停,不要继续做危险的下一步**:npm 装包失败时**绝不重启 dsh**,
  否则等于用一个没装上的版本把服务弄挂。
- **注入执行器和时钟**(`run` / `now`),测试才能在毫秒内跑完一条几十秒的真实流程。
- **状态要落盘**:跨重启要用的东西(如"上一版本")写 `data/`(已 gitignore),
  内存状态用于任务进度即可。
