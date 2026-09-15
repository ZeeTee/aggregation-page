/**
 * POST /api/dsh/restart —— 一键重启本机 dsh(pm2 托管)
 * ============================================================================
 * ⚠️ 这是本项目**唯一有副作用的接口**,所以约束比其他接口更严:
 *
 *   1. 必须带 X-Api-Key(路由标记 auth: true,由 server/api.ts 统一校验)
 *   2. **不执行任何用户输入**:命令与参数都是常量(pm2Bin + 'restart' + appName),
 *      用 execFile 而非 exec —— 不经 shell,不存在拼接/注入面
 *   3. 冷却:同一时间窗口内只允许重启一次,防止被反复触发把 dsh 打进重启循环
 *   4. 前端有二次确认(见 tools/dsh-restart/main.ts),密钥每次都要重新输入
 *
 * 为什么用 pm2 命令而不是直接发信号:pm2 才是 dsh 的进程管理者,
 * 由它执行 restart 才能拿到确定的结果(进程退出→重新拉起→新 token 打印进日志)。
 *
 * 重启之后会发生什么:
 *   · dsh 进程重启,生成**新的进程级 token**,旧 token 与旧登录 cookie 立即失效
 *   · 所有正在进行的 dsh 会话断开(包括 Web GUI 标签页)
 *   · 本服务(aggregation-page)不受影响,所以「新地址」可以从工具箱页面拿到
 *
 * 调用方(前端)的完整流程:
 *   ① GET /api/dsh/login-url      记录重启前的 tokenPreview
 *   ② POST /api/dsh/restart       触发重启(本文件)
 *   ③ 轮询 GET /api/dsh/login-url 直到 tokenPreview 变化且 valid → 展示新地址
 *
 * 错误码:
 *   401 unauthorized      密钥不对(server/api.ts)
 *   503 api_key_not_configured  服务端未配置密钥
 *   429 restart_cooldown  冷却中,请稍后再试(带 Retry-After)
 *   503 pm2_not_found     找不到 pm2 可执行文件(路径配置错误)
 *   502 restart_failed    pm2 命令返回失败(详见服务端日志)
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

import type { DshRestartResult } from '../../src/shared/types.ts';
import { ApiError, type Route } from '../api.ts';

/** 注入给 execFile 的超时:pm2 restart 正常在 1 秒内返回 */
const EXEC_TIMEOUT_MS = 20_000;

export interface DshRestartDeps {
  /** pm2 可执行文件路径(默认 /usr/local/bin/pm2) */
  pm2Bin: string;
  /** pm2 应用名(默认 dsh) */
  appName: string;
  /** pm2 的数据目录;systemd 下 HOME 可能不同,显式传更稳妥 */
  pm2Home: string;
  /** 冷却秒数:距上次成功重启不足这个时间就直接拒绝 */
  cooldownSeconds: number;
  /** 可注入的执行器(测试用):返回是否成功与详情 */
  run?: (pm2Bin: string, appName: string) => Promise<{ ok: boolean; detail: string }>;
  /** 可注入的时钟(测试用) */
  now?: () => number;
}

/** 默认执行器:用 node 显式跑 pm2 脚本,避免依赖 shebang / exec 位 / PATH。 */
function defaultRun(pm2Bin: string, appName: string, pm2Home: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [pm2Bin, 'restart', appName],
      {
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        // PM2_HOME 决定 CLI 去找哪个 daemon;不传时 root 下通常也是 /root/.pm2,但显式更稳
        env: { ...process.env, PM2_HOME: pm2Home },
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ ok: false, detail: `${error.message} | ${String(stderr || stdout).trim()}`.slice(0, 500) });
          return;
        }
        resolve({ ok: true, detail: String(stdout).trim().slice(0, 300) });
      },
    );
  });
}

/**
 * 路由工厂。依赖注入(pm2 路径、执行器、时钟)让"重启+冷却"的逻辑可以离线测试,
 * 测试里不会真的去重启 dsh。
 */
export function dshRestartRoute(deps: DshRestartDeps): Route {
  const injected = deps.run !== undefined;
  const run = deps.run ?? ((bin: string, app: string) => defaultRun(bin, app, deps.pm2Home));
  const now = deps.now ?? (() => Date.now());
  const cooldownMs = Math.max(0, deps.cooldownSeconds) * 1000;

  /** 上次**成功**重启的时间戳;0 表示本次进程内还没重启过 */
  let lastRestartAt = 0;

  return {
    method: 'POST',
    path: '/api/dsh/restart',
    auth: true,
    handle: async (ctx) => {
      // ── 冷却检查 ──────────────────────────────────────────────────
      if (lastRestartAt !== 0) {
        const elapsed = now() - lastRestartAt;
        if (elapsed < cooldownMs) {
          const retryAfter = Math.ceil((cooldownMs - elapsed) / 1000);
          ctx.log.warn('dsh restart rejected (cooldown)', { retryAfter, ip: ctx.ip });
          throw new ApiError(429, 'restart_cooldown', `刚刚重启过,请 ${retryAfter} 秒后再试`, retryAfter);
        }
      }

      // ── 可执行文件存在性(注入了执行器时跳过,便于测试)────────────
      if (!injected && !existsSync(deps.pm2Bin)) {
        ctx.log.error('pm2 not found', { pm2Bin: deps.pm2Bin });
        throw new ApiError(503, 'pm2_not_found', '服务端找不到 pm2,无法重启 dsh(请检查 PM2_BIN 配置)');
      }

      // ── 执行重启(命令与参数全是常量,无用户输入)──────────────────
      const startedAt = now();
      const result = await run(deps.pm2Bin, deps.appName);
      if (!result.ok) {
        // 详情只进日志:可能包含本机路径等信息,不适合直接回给公网调用方
        ctx.log.error('dsh restart failed', { detail: result.detail, ip: ctx.ip });
        throw new ApiError(502, 'restart_failed', '重启命令执行失败,请查看服务端日志');
      }

      lastRestartAt = now();
      const tookMs = lastRestartAt - startedAt;
      ctx.log.info('dsh restarted', { app: deps.appName, tookMs, ip: ctx.ip, detail: result.detail });

      const payload: DshRestartResult = {
        restarted: true,
        appName: deps.appName,
        tookMs,
        at: new Date().toISOString(),
        note: '旧登录地址与旧登录态已失效,请用新地址重新打开 dsh',
      };
      return payload;
    },
  };
}
