# 🔑 DSH 登录地址(`tools/dsh-url/`)

点一个按钮,拿到**本机正在运行的 DSH Web UI 登录地址**(含进程 token),可以直接打开或复制。

> ⚠️ **这个地址里的 token 等同于 root 级入口**(DSH 以 root 运行、能执行 shell)。
> 页面默认打码显示,请勿分享、勿截图外发。

---

## 1. 它解决什么问题

`dsh web` 启动时会打印一行带 token 的地址,例如:

```
dsh web: http://127.0.0.1:3080/?token=Z_m2ExWK...
```

这个 token 是**进程级**的:

| 特性 | 说明 |
| --- | --- |
| 生成方式 | `processLaunchToken()` 用 `randomBytes` 生成,**只存在于进程内存**,不落盘 |
| 生命周期 | 随 `dsh web` 进程存活;进程一重启就换新 token,旧的立刻失效 |
| 唯一痕迹 | 启动时打印的那一行日志(本机是 pm2 收集到 `/root/.pm2/logs/dsh-out.log`) |
| 交换方式 | `GET /?token=<token>` 且 **`Host` 头必须是受信 authority** → 303 重定向并下发 cookie |

所以"查当前地址"= **读 pm2 日志里最后一条 token + 用 303 校验它还有效**。
命令行等价物是服务器上的 `/root/dsh-login-url.sh`,本工具就是把它搬到了网页上。

**最容易踩的坑**:直接请求 `http://127.0.0.1:3080/?token=…`(Host 为 `127.0.0.1:3080`)
会返回 **401**;必须带上 `Host: dsh.zeetng.cloud` 才会返回 **303**。
本工具在服务端发校验请求时会显式设置这个头(`server/routes/dsh.ts` 的 `httpValidate`)。

---

## 2. 工作原理

```
浏览器                      Node 服务端                       本机
  │                            │                              │
  │ ① 点按钮(带 X-Api-Key)     │                              │
  ├───────────────────────────►│                              │
  │                    ② 校验密钥(常量时间比较)                │
  │                    ③ 读 pm2 日志,取最后一条 token          │
  │                            ├─────────────────────────────►│ /root/.pm2/logs/dsh-out*.log
  │                    ④ 带 Host 头请求 /?token=… 期望 303      │
  │                            ├─────────────────────────────►│ 127.0.0.1:3080
  │ ⑤ 返回 {url, valid, …}      │                              │
  │◄───────────────────────────┤                              │
  │ ⑥ 打码显示 / 复制 / 打开     │                              │
```

分步说明:

1. **前端**(`main.ts`):只从输入框读密钥 → 通过 `X-Api-Key` 请求头发给后端。
2. **鉴权**(`server/api.ts`):标记了 `auth: true` 的路由统一走"独立限流 → 全局失败预算 → 密钥校验"。
3. **取 token**(`server/routes/dsh.ts` 的 `findLatestToken`):按修改时间从新到旧扫描日志文件,
   取**最后一个**匹配 `token=([A-Za-z0-9_-]+)` 的值,并记下"哪个文件第几行"(排障用)。
4. **校验 token**(`httpValidate`):带 `Host: <DSH_PUBLIC_HOST>` 请求 `/?token=…`,只有 **303** 才算有效。
   直连 127.0.0.1 会 401,所以这个头是必需的。
5. **返回**:`{ url, host, port, tokenPreview, valid, checkedAt, source }`(类型见 `src/shared/types.ts`)。
   `tokenPreview` 只给前 8 位,便于人工核对;`valid: false` 表示 dsh 重启过、token 已失效。
6. **展示**:默认打码成 `token=••••••••••••`,点"显示完整地址"才展开;另有复制与直接打开。

---

## 3. 密钥策略

| 项 | 约定 |
| --- | --- |
| 密钥来源 | 服务端 `.env` 的 `TOOLBOX_API_KEY`(本机固定为 `521016`) |
| 前端行为 | **每次获取都要重新输入,不做任何保存**(不写 localStorage / sessionStorage / cookie);请求结束立即清空输入框 |
| 传输方式 | 只走 `X-Api-Key` 请求头,**绝不放进 URL**(避免 Referer / 访问日志泄漏) |
| 未配置时 | 服务端返回 **503**(fail-closed,绝不放行) |
| 错误密钥 | 401;累计失败会触发冷却(见下) |
| 防爆破 | 该接口独立限流 **5 次/分钟/IP**;全局失败预算:10 分钟内累计失败 10 次 → 整个鉴权接口冷却 10 分钟(`429 auth_locked`) |
| 日志 | 只记 token 前 8 位;响应 `Cache-Control: no-store` |

> 密钥强度提醒:6 位数字只有 100 万种可能。上面的限流/失败预算能挡住单机爆破与部分分布式猜测,
> 但**不能替代强密钥**。要换:`openssl rand -hex 32` 写进 `.env` 后 `systemctl restart aggregation-page`。

---

## 4. 相关配置(`.env`)

```bash
TOOLBOX_API_KEY=521016          # 访问密钥
AUTH_RATE_LIMIT=5               # 该接口每分钟每 IP 上限
AUTH_FAILURE_BUDGET=10          # 全局失败预算阈值

DSH_LOG_DIR=/root/.pm2/logs     # pm2 日志目录
DSH_LOG_PREFIX=dsh-out          # 日志文件名前缀
DSH_PUBLIC_HOST=dsh.zeetng.cloud  # 对外 host,同时是校验请求必须带的 Host 头
DSH_PORT=3080                   # 本机 dsh web 端口
```

---

## 5. 排障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 页面提示「服务端未配置密钥」 | `.env` 里 `TOOLBOX_API_KEY` 为空 | 填上并 `systemctl restart aggregation-page` |
| 页面提示「密钥不正确」 | 输错了 | 重新输入;连续错 10 次会冷却 10 分钟 |
| 页面提示「地址已失效」(`valid: false`) | dsh 重启过,token 换了 | 服务器执行 `pm2 restart dsh` 后重新获取 |
| 「未找到 token,dsh web 可能没在 pm2 下运行」 | 日志里没有 `token=`,或日志目录/前缀配错 | `pm2 list` 确认进程;`grep -h 'dsh web:' /root/.pm2/logs/dsh-out*` 看日志 |
| 「无法校验 token」 | 本机 3080 不通(进程挂了) | `ss -tlnp | grep 3080`、`pm2 logs dsh` |
| 401 但密钥没错 | 通过 IP/其它域名访问时 `Host` 不匹配 | 用 `https://dsh.zeetng.cloud` 打开 dsh;`DSH_PUBLIC_HOST` 要与之一致 |

人工核对(服务器上,与工具结果比对):

```bash
bash /root/dsh-login-url.sh          # 官方脚本:输出当前有效地址
```

---

## 6. 涉及文件

| 文件 | 职责 |
| --- | --- |
| `tools/dsh-url/tool.json` | 工具元数据(`api: true`,图标、标签、排序) |
| `tools/dsh-url/index.html` | 页面结构(输入框常显、结果区默认隐藏) |
| `tools/dsh-url/main.ts` | 交互逻辑:取密钥 → 调接口 → 打码展示 / 复制 / 打开 / 错误提示 |
| `tools/dsh-url/style.css` | 仅本工具特有的样式(通用组件来自 `src/shared/base.css`) |
| `server/routes/dsh.ts` | 后端接口:日志取 token、303 校验、结果缓存、错误码 |
| `server/api.ts` | `auth: true` 的通用鉴权流程(限流、失败预算、密钥比较) |
| `server/security.ts` | `apiKeyMatches`(常量时间)与 `FailureBudget`(全局失败预算) |
| `src/shared/api.ts` | 前端 `callApi()`:统一信封 → 类型化 `ApiError` |
| `src/shared/types.ts` | `DshLoginUrl` 类型(前后端共用) |
| `tests/dsh.test.ts` | 后端 17 例:密钥比较、失败预算、日志解析、路由分支、HTTP 鉴权 |
| `tests/dsh-url.test.ts` | 前端 7 例:不保存密钥、空输入不发请求、用后清空、打码显示 |

---

## 7. 本地自测

```bash
npm run build && PORT=8081 node dist-server/index.js     # 起一份服务

# 不带密钥 → 401
curl -i http://127.0.0.1:8081/api/dsh/login-url

# 带密钥 → 200,返回有效地址
curl -s -H "X-Api-Key: 521016" http://127.0.0.1:8081/api/dsh/login-url

# 单独跑本工具的测试
npx vitest run tests/dsh.test.ts tests/dsh-url.test.ts
```
