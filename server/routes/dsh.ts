/**
 * GET /api/dsh/login-url —— 返回本机 DSH Web UI 的登录地址(含进程 token)
 * ============================================================================
 * 为什么需要后端:token 只存在于 dsh 进程内存与它的启动日志里,浏览器拿不到。
 *
 * 完整链路(前端视角见 tools/dsh-url/README.md 的流程图):
 *
 *   1) 鉴权     路由标记 auth: true → server/api.ts 统一做"独立限流 → 全局失败预算 → 密钥比较"
 *   2) 取 token  findLatestToken():扫描 pm2 日志,取**最后一条** `token=...`
 *   3) 校验      httpValidate():带 Host 头请求 /?token=…,只有 **303** 才算仍然有效
 *   4) 返回      { url, host, port, tokenPreview, valid, checkedAt, source }
 *
 * ⚠️ 安全:这个 token 交换出的 cookie 能以 root 身份登录 DSH,属**高价值凭据**:
 *   · 接口必须带 X-Api-Key(未配置密钥时返回 503,而不是放行)
 *   · 日志只记 token 前 8 位(httpValidate 不发日志,只在成功时记 tokenPrefix)
 *   · 响应 Cache-Control: no-store(由 server/api.ts 统一加)
 *   · 前端默认打码显示
 *
 * 错误码(前端按 code 出中文提示,见 tools/dsh-url/main.ts):
 *   503 token_not_found   日志里找不到 token(dsh 没在 pm2 下跑?日志目录/前缀配错?)
 *   502 validate_failed   本机 3080 连不上或校验请求超时(进程挂了?)
 *   401 unauthorized      密钥不对(由 server/api.ts 抛出)
 *   429 auth_locked       失败次数过多,鉴权接口整体冷却
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';

import type { DshLoginUrl } from '../../src/shared/types.ts';
import { ApiError, type Route } from '../api.ts';

/**
 * token 的字符集必须与服务器上的 /root/dsh-login-url.sh 保持一致
 * (它用的是 `grep -o 'token=[A-Za-z0-9_-]\+'`),否则两边会取出不同的值。
 */
const TOKEN_PATTERN = /token=([A-Za-z0-9_-]+)/g;

/**
 * 校验结果的短缓存。
 * 目的:连点按钮时不要在几毫秒内反复请求本地 dsh。
 * 不影响正确性 —— 缓存以 **token 值**为 key,进程重启换了 token 就是缓存未命中,必然重新校验。
 */
const CACHE_MS = 5_000;

/** 校验请求的超时(本地回环,5 秒足够;超时按校验失败处理) */
const VALIDATE_TIMEOUT_MS = 5_000;

export interface DshRouteDeps {
  /** pm2 日志目录,例如 /root/.pm2/logs */
  logDir: string;
  /** 日志文件名前缀,例如 dsh-out(会匹配 dsh-out.log、dsh-out-1.log …) */
  logPrefix: string;
  /** 对外 host:既用于拼最终 URL,也用于校验时的 Host 头(**必须正确**) */
  publicHost: string;
  /** 本机 dsh web 端口 */
  port: number;
  /** 可注入的校验函数(返回 HTTP 状态码);测试用它避免真的去打 3080 */
  validate?: (token: string) => Promise<number>;
}

/** 命中的 token 及其出处(文件:行号,排障时一眼能定位) */
export interface TokenHit {
  token: string;
  source: string;
}

export type { DshLoginUrl };

/**
 * 在所有匹配的日志文件里找**最后一条** token。
 *
 * 为什么要按 mtime 从新到旧:pm2 会按启动次数产生 dsh-out.log / dsh-out-1.log 等,
 * **只有最新那个文件里的 token 可能属于当前进程**;老文件里的 token 早就随进程退出失效了。
 * 找到第一个"含 token 的文件"就返回,不去读更老的文件。
 *
 * 目录不存在、文件读不了都只返回 null(不抛异常):由调用方转成 503 并给出可读提示。
 */
export async function findLatestToken(logDir: string, logPrefix: string): Promise<TokenHit | null> {
  let names: string[];
  try {
    names = await readdir(logDir);
  } catch {
    return null;
  }

  const candidates = names.filter((name) => name.startsWith(logPrefix));
  if (candidates.length === 0) return null;

  // 先按修改时间排序(取不到时间的当 0,排到最后)
  const withTime = await Promise.all(
    candidates.map(async (name) => {
      try {
        return { name, mtimeMs: (await stat(join(logDir, name))).mtimeMs };
      } catch {
        return { name, mtimeMs: 0 };
      }
    }),
  );
  withTime.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const file of withTime) {
    let text: string;
    try {
      text = await readFile(join(logDir, file.name), 'utf8');
    } catch {
      continue; // 单个文件读失败不影响其它文件
    }

    // 逐行匹配,保留最后一条(同一文件里可能有多条历史 token)
    let hit: TokenHit | null = null;
    text.split('\n').forEach((line, index) => {
      for (const match of line.matchAll(TOKEN_PATTERN)) {
        const token = match[1];
        if (token !== undefined && token !== '') {
          hit = { token, source: `${file.name}:${index + 1}` };
        }
      }
    });
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * 用带受信 Host 头的请求换取 303,确认 token 仍属于当前进程。
 *
 * **这是本项目最容易踩的坑**:dsh 的鉴权实现会校验请求的 authority,
 * 直接请求 `http://127.0.0.1:3080/?token=…`(Host 变成 127.0.0.1:3080)一律返回 401;
 * 必须显式设置 `Host: <DSH_PUBLIC_HOST>` 才会 303 并下发 cookie。
 *
 * 这里只取状态码:丢弃响应体、不保存 cookie(我们不需要登录态,只要"有没有效"这个事实)。
 */
export function httpValidate(port: number, host: string, token: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: `/?token=${encodeURIComponent(token)}`,
        method: 'GET',
        headers: { Host: host },
      },
      (res) => {
        res.resume(); // 丢弃响应体
        resolve(res.statusCode ?? 0);
      },
    );
    req.setTimeout(VALIDATE_TIMEOUT_MS, () => req.destroy(new Error('校验请求超时')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * 路由工厂。依赖注入(logDir/host/port/validate)让这个路由能在测试里跑,
 * 不必依赖真实的 pm2 目录与本地 dsh 进程。
 */
export function dshRoute(deps: DshRouteDeps): Route {
  const validate = deps.validate ?? ((token: string) => httpValidate(deps.port, deps.publicHost, token));
  let cache: { token: string; valid: boolean; at: number } | undefined;

  return {
    method: 'GET',
    path: '/api/dsh/login-url',
    auth: true, // ← 由 server/api.ts 统一执行密钥校验与限流
    handle: async (ctx) => {
      // ── 1. 取 token ────────────────────────────────────────────────
      const hit = await findLatestToken(deps.logDir, deps.logPrefix);
      if (hit === null) {
        throw new ApiError(
          503,
          'token_not_found',
          `未在 ${deps.logDir}/${deps.logPrefix}* 找到 token,dsh web 可能没在 pm2 下运行`,
        );
      }

      // ── 2. 校验(带 5 秒结果缓存,按 token 值判定是否命中)──────────
      const now = Date.now();
      let valid: boolean;
      if (cache !== undefined && cache.token === hit.token && now - cache.at < CACHE_MS) {
        valid = cache.valid;
      } else {
        let status: number;
        try {
          status = await validate(hit.token);
        } catch (error) {
          // 连不上本机 dsh / 超时:这属于"校验不了",与"token 失效"要区分开
          throw new ApiError(502, 'validate_failed', `无法校验 token:${(error as Error).message}`);
        }
        valid = status === 303; // 只有 303 才算有效;401 表示这个 token 属于旧进程
        cache = { token: hit.token, valid, at: now };
      }

      // ── 3. 记日志:只记前 8 位,够排障又不足以复现凭据 ──────────────
      ctx.log.info('dsh login url issued', {
        tokenPrefix: hit.token.slice(0, 8),
        valid,
        source: hit.source,
        ip: ctx.ip,
      });

      // ── 4. 返回。注意即使 valid=false 也把 url 带上,便于前端展示失效地址与提示 ──
      const payload: DshLoginUrl = {
        url: `https://${deps.publicHost}/?token=${hit.token}`,
        host: deps.publicHost,
        port: deps.port,
        tokenPreview: hit.token.slice(0, 8),
        valid,
        checkedAt: new Date().toISOString(),
        source: hit.source,
      };
      return payload;
    },
  };
}
