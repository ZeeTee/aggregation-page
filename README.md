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
├── package.json / tsconfig.json / vite.config.ts
├── index.html                    # 门户页入口
├── src/
│   ├── hub/                      # 门户:卡片渲染、搜索、标签过滤
│   ├── shared/                   # 前端共享:types / dom / toast / clipboard / base.css
│   └── build/                    # 构建期:扫描 tools/、virtual:tools、tools.json
├── tools/                        # 一个目录一个工具
│   ├── timestamp/                #   TS 工具:index.html + main.ts + style.css
│   └── json-format/              #   vanilla 工具(渐进迁移中,原样拷贝)
├── tests/                        # Vitest:元数据校验 + 门户渲染
├── server/                       # (P2)Node 服务:静态 + /api
├── dist/                         # 构建产物(gitignore)
├── public/                       # Python 版的产物(gitignore,迁移期保留)
├── deploy/                       # systemd 单元
└── docs/ts-rewrite-plan.md       # 架构与实施方案
```

## 常用命令

```bash
npm install            # 首次
npm run dev            # 开发服务器(HMR)http://127.0.0.1:5173
npm run build          # 构建到 dist/
npm run preview        # 预览构建产物 http://127.0.0.1:8081
npm run typecheck      # tsc 全量类型检查
npm test               # Vitest(21 个用例)
```

构建约 **0.1 秒**,21 个测试约 **2 秒**。

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

## 部署

```
访客 → Cloudflare 边缘(自动 HTTPS)→ cloudflared 隧道 → 本机 127.0.0.1:8080(静态 + /api)
```

```bash
# 构建 + 重启服务
npm run build
sudo systemctl restart aggregation-page

# 隧道配置在 /etc/cloudflared/config.yml(C 记录指向隧道,无需开端口/备案)
```

## 安全约定(后端工具必读)

站点经隧道对公网开放,因此 `/api/*` 一律按公网可达设计:

- 密钥只放 `.env`(600 权限,不入库),**不得**进入前端 bundle
- 需要凭据的接口用共享密钥(`X-Api-Key`),**未配置密钥时返回 503 而不是放行**
- 不接受任意文件路径、不执行 shell、外部请求域名写死白名单(防 SSRF)
- 所有 `/api/*` 限流(默认 60 次/分钟/IP)
- 响应带 `Cache-Control: no-store` 的接口不得被缓存

## 迁移状态(与 Python 版的关系)

| 部分 | Python 版 | TypeScript 版 |
| --- | --- | --- |
| 门户页 | `build.py` + `aggregation_page/render.py` | ✅ `src/hub` + Vite |
| 工具构建 | 整目录拷贝 | ✅ TS 工具编译 + vanilla 拷贝 |
| 工具元数据 | `registry.py` | ✅ `src/build/tools.ts`(带校验) |
| 静态服务 | `serve.py`(systemd 当前在用) | ⏳ P2 |
| 后端接口 | 无 | ⏳ P2 |

迁移期约定:

- **带 `main.ts` 的工具由 TS 版构建**,Python 版会自动跳过(见 `registry.py` 的守卫),
  避免产出无法执行的页面
- 线上仍由 Python 版服务 `public/`;TS 版构建到 `dist/`,在 8081 端口验证后再切换
- 全部切换稳定运行一周后,可删除 Python 实现(`build.py`、`serve.py`、`aggregation_page/`)

## 文档

- `docs/ts-rewrite-plan.md` —— 架构、接口设计、分阶段实施计划、风险与决策记录
