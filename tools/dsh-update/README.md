# 🤖 DSH 更新

检测 DSH(`@deepseek-ai/dsh`)有没有新版本,**一键更新并重启**;升级出问题还能**一键回滚**。

线上:https://www.zeetng.cloud/tools/dsh-update/

## ⚠️ 先读这段

这个工具会**更新并重启 dsh 本身** —— 也就是你正在用的这个 GUI 的宿主。

- 重启会让**当前所有会话断开**(包括正在对话的 AI 助手)
- 升到**坏版本会让 dsh 起不来**

正因为如此,回滚入口刻意放在**本工具站**而不是 dsh 里:本工具站是**独立服务**
(systemd `aggregation-page`),dsh 挂了它照样活着 —— 所以它是唯一还能自救的入口。
真要出事,你不需要 SSH,打开这个页面点「回滚」就行。

## 用法

1. 输入访问密钥 → 点「检测新版本」
2. 页面显示:当前版本、npm 各通道版本、可回滚到的版本
3. 选择目标(通道或具体版本)→ 点「更新并重启」
4. **二次确认** → 执行,页面实时显示进度:
   `安装 → 重新打补丁 → 重启 dsh → 等待新令牌`
5. 完成后展示**新的登录地址**(默认打码,可显示/复制/直接打开)

出问题就点「回滚到 &lt;版本&gt;」,同样是二次确认 + 进度 + 新地址。

## 为什么不做"谁新谁旧"的判断

本机同时存在多个通道,而且**通道之间不可比大小**。真实情况:

| | 版本 |
| --- | --- |
| 本机已安装 | `0.1.6-alpha.2` |
| npm `latest` | `0.1.5-rc.2` ← **比已装的还旧** |
| npm `next` | `0.1.5-rc.2` |
| npm `alpha` | `0.1.6-alpha.2` |

所以工具**只如实展示**,由人来选目标 —— 如果按"latest 才是最新"来判断,会错误地建议你降级。

## 关于 loopback 补丁

升级会 `npm install -g` **整包覆盖**,而"让 `dsh.zeetng.cloud` 被当作 loopback"
的补丁正是改在包内的 `dsh-client-connection/lib/client.js` 上 —— 所以**必然丢失**。
更新流程会在安装后**自动重新打上**(脚本见 `DSH_PATCH_SCRIPT`),完成页会标注结果。

> 不打这个补丁的后果:通过公网域名访问时,「设置」页面会报
> `settings are unavailable in this browser`(DSH 只在 loopback 来源下启用宿主持久化的设置)。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dsh/update` | 🔑 当前版本、各通道版本、任务进度 |
| POST | `/api/dsh/update` | 🔑⚠️ 启动更新或回滚(**后台任务**,带冷却) |

**为什么是"后台任务 + 轮询"**:npm 安装几十秒,加上重启后等新令牌(实测 dsh 启动到
打印 token 约 8.6 秒),远超接口层 10 秒单请求超时。所以 POST 只负责**启动**并立刻返回,
前端每 4 秒轮询一次进度。

## 安全约束

- 两个接口都要 `X-Api-Key`(fail-closed:未配置密钥返回 503,不放行)
- **命令全是常量 + argv 数组**(`execFile`,不经 shell);版本号做**白名单校验**
  (`^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$`),`latest; rm -rf /` 这类输入直接 400
- 同一时刻**只允许一个任务**;成功后进入冷却(默认 60 秒)
- 失败详情只进服务端日志;**npm 装包失败时绝不会去重启 dsh**(否则等于用一个没装上的版本把服务弄挂)
- 前端密钥每次重新输入、不持久化;日志只记 token 前 8 位

## 配置

```bash
DSH_NPM_BIN=/usr/bin/npm
DSH_PACKAGE=@deepseek-ai/dsh
DSH_MODULE_DIR=/usr/local/lib/node_modules/@deepseek-ai/dsh   # 读 package.json 拿当前版本
DSH_PATCH_SCRIPT=/root/dsh-loopback-host-patch.sh             # 传空串可关闭自动重打
DSH_PATCH_HOST=dsh.zeetng.cloud
DSH_UPDATE_TIMEOUT=300     # npm 安装超时(秒)
DSH_UPDATE_COOLDOWN=60     # 两次成功更新之间的最小间隔(秒)
# DSH_UPDATE_STATE=<项目根>/data/dsh-update.json   # 上一版本记录(用于回滚)
```

## 排障

| 现象 | 处理 |
| --- | --- |
| 「密钥不正确」 | 与其他工具共用 `.env` 的 `TOOLBOX_API_KEY` |
| 「服务端找不到 npm」 | 检查 `DSH_NPM_BIN` |
| 「查询 npm 失败」 | 网络/镜像源问题;工具仍可用,只是没有可选目标 |
| 更新后没等到新地址 | 到「DSH 登录地址」工具再取;任务本身算成功 |
| 更新后 dsh 起不来 | **点「回滚到 &lt;上一版本&gt;」** —— 本工具站不受 dsh 影响,一定能打开 |
| 想手工回滚 | `npm install -g @deepseek-ai/dsh@<版本>` 然后重启 dsh |

服务端日志:`journalctl -u aggregation-page -n 80`(更新/失败都会记录)。
