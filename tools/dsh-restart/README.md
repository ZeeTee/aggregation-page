# 🔄 重启 DSH(`tools/dsh-restart/`)

一键重启本机 `dsh web`(pm2 托管),重启完成后**自动取回新的登录地址**。

> ⚠️ 这是站内**唯一会改变系统状态**的工具:
> 重启会**断开所有 dsh 会话**(包括正在进行的对话),并让旧登录地址立即失效。
> 所以它有三道护栏:密钥、二次确认、服务端冷却。

---

## 1. 为什么需要它

`dsh web` 的登录地址(token)是**进程级**的:进程一重启就换新 token,旧地址立刻失效。
所以"重启"和"重新拿地址"总是成对发生。这个工具把两件事串成一个流程,省得去服务器上敲命令。

顺带说明:**本工具所在的服务(aggregation-page)是独立的 systemd 服务,不受 dsh 重启影响** ——
所以重启期间这个页面不会掉线,可以在这里看到全过程和最终的新地址。

---

## 2. 流程

```
你(浏览器)                工具箱后端                     本机
   │                          │                          │
   │ ① 输入密钥,点「重启 DSH…」 │                          │
   ├─────────────────────────►│                          │
   │                    ② GET /api/dsh/login-url         │
   │                       (验证密钥 + 记下"重启前 token")  │
   │◄─────────────────────────┤                          │
   │ ③ 显示确认区(不执行任何操作)                          │
   │                          │                          │
   │ ④ 点「确认重启」           │                          │
   ├─────────────────────────►│                          │
   │                    ⑤ pm2 restart dsh                │
   │                          ├─────────────────────────►│ dsh 重启,打印新 token
   │                    ⑥ 轮询 login-url 直到 token 变化   │
   │◄─────────────────────────┤                          │
   │ ⑦ 展示新地址(默认打码)+ 复制 / 打开                   │
```

界面上的进度条会把 ⑤⑥⑦ 逐步显示出来,超时(35 秒)会给出明确提示而不是一直转圈。

---

## 3. 三道护栏

| 护栏 | 位置 | 说明 |
| --- | --- | --- |
| **密钥** | 服务端 | 接口标记 `auth: true`:未配置密钥 → 503;密钥错 → 401;只走 `X-Api-Key` 头。每次执行都要重新输入,不保存 |
| **二次确认** | 前端 | 点主按钮只做"读取当前状态",**必须再点「确认重启」**才会真正下发命令;点取消会连内存里暂存的密钥一起丢弃 |
| **冷却** | 服务端 | `DSH_RESTART_COOLDOWN`(默认 60 秒)内只允许成功重启一次,超限返回 `429 restart_cooldown` + `Retry-After`,防止被反复触发把 dsh 打进重启循环 |

另外两条实现上的硬约束:

- **命令是常量**:服务端执行的是 `node <PM2_BIN> restart <DSH_APP_NAME>`,用 `execFile`(**不经 shell**)。
  调用方传 query/body 都改变不了它(测试里专门验证了这一点)。
- **失败不进冷却**:pm2 报错时返回 502 且**不**开始计冷却,方便立刻重试。

> ⚠️ 风险提示:密钥若是 6 位数字(如当前部署的 `521016`),一旦被暴力猜中,
> 攻击者可以反复重启 dsh(拒绝服务)。缓解手段是密钥失败预算(10 分钟 10 次失败即整体冷却 10 分钟)
> 与本接口的 60 秒冷却;但**根本办法仍是换强密钥**(`openssl rand -hex 32`)。
> 如果将来出现更多有副作用的接口,建议整体加一层 Cloudflare Access。

---

## 4. 相关配置(`.env`)

```bash
TOOLBOX_API_KEY=521016          # 访问密钥
AUTH_RATE_LIMIT=5               # 鉴权接口每分钟每 IP 上限
AUTH_FAILURE_BUDGET=10          # 全局失败预算

PM2_BIN=/usr/local/bin/pm2      # pm2 可执行文件
PM2_HOME=/root/.pm2             # pm2 数据目录(决定 CLI 连哪个 daemon)
DSH_APP_NAME=dsh                # pm2 里的应用名
DSH_RESTART_COOLDOWN=60         # 冷却秒数(0 = 不限制)
```

---

## 5. 排障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 「服务端未配置密钥」 | `.env` 里 `TOOLBOX_API_KEY` 为空 | 填上并 `systemctl restart aggregation-page` |
| 「密钥不正确」 | 输错了 | 重新输入;连续错 10 次会整体冷却 10 分钟 |
| 「刚刚重启过,请 N 秒后再试」 | 冷却中 | 等 N 秒 |
| 「服务端找不到 pm2」 | `PM2_BIN` 路径不对 | `command -v pm2` 看真实路径,改 `.env` |
| 「重启命令执行失败」 | pm2 CLI 连不上 daemon(未运行 / `PM2_HOME` 不对) | 看 `journalctl -u aggregation-page -n 50`;`PM2_HOME=/root/.pm2 pm2 ping` 应返回 `pong` |
| 重启成功但取不到新地址 | dsh 启动慢或启动失败 | 看 `pm2 logs dsh --lines 30`;也可稍后用「DSH 登录地址」工具再取一次 |
| 页面点确认后没反应 | 浏览器拦截了新窗口 | 手动复制地址打开 |

服务器上人工确认 pm2 状态(与工具用的是同一条调用链):

```bash
PM2_HOME=/root/.pm2 pm2 list
PM2_HOME=/root/.pm2 pm2 logs dsh --lines 20   # 里面会打印新的登录地址
```

---

## 6. 涉及文件

| 文件 | 职责 |
| --- | --- |
| `tools/dsh-restart/tool.json` | 元数据(`api: true`,图标、标签、排序) |
| `tools/dsh-restart/index.html` | 页面结构:输入区 / 当前状态 / 二次确认 / 进度 / 结果 |
| `tools/dsh-restart/main.ts` | 流程编排:读状态 → 确认 → 重启 → 轮询新地址 → 展示 |
| `tools/dsh-restart/style.css` | 危险按钮、确认卡片、进度步骤样式 |
| `server/routes/dsh-restart.ts` | 后端:`execFile` 执行固定命令、冷却状态机、错误码 |
| `server/api.ts` | 通用鉴权(限流 / 失败预算 / 密钥比较)与 `ApiError` |
| `src/shared/types.ts` | `DshRestartResult` 类型(前后端共用) |
| `tests/dsh-restart.test.ts` | 后端 9 例:鉴权、命令白名单、冷却、失败分支 |
| `tests/dsh-restart-ui.test.ts` | 前端 6 例:未确认不发请求、取消后密钥失效、打码展示、不写存储 |

---

## 7. 自测

```bash
npm run build && PORT=8081 node dist-server/index.js

# 安全的自测(不会真的重启):只验证鉴权与错误分支
curl -i -X POST http://127.0.0.1:8081/api/dsh/restart                        # 401
curl -i -X POST -H "X-Api-Key: wrong" http://127.0.0.1:8081/api/dsh/restart   # 401
curl -i -X POST -H "X-Api-Key: 521016" http://127.0.0.1:8081/api/dsh/restart  # ⚠️ 会真的重启 dsh!

# 只跑本工具的测试(用注入的执行器,不会碰到真实 pm2)
npx vitest run tests/dsh-restart.test.ts tests/dsh-restart-ui.test.ts
```
