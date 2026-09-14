/**
 * GET /api/dsh/login-url —— 返回本机 DSH Web UI 的登录地址(含进程 token)。
 *
 * 背景(实测结论,详见 docs/ts-rewrite-plan.md §12):
 *   · token 是 `dsh web` 进程启动时用 randomBytes 生成的**进程级令牌**,不落盘,
 *     只在启动日志里出现过一次;进程重启即失效
 *   · 交换方式:`GET /?token=<token>`,且 **Host 头必须是受信 authority**
 *     (直接请求 127.0.0.1:3080 会 401,必须带 Host: dsh.zeetng.cloud 才 303)
 *   · 因此唯一的取法:读 pm2 日志最后一条 `token=...`,再用 303 校验
 *
 * ⚠️ 安全:该 token 交换出的 cookie 可登录 DSH(以 root 运行),属**高价值凭据**:
 *   · 接口标记 auth: true,必须带 X-Api-Key
 *   · 日志只记录 token 前 8 位
 *   · 响应 Cache-Control: no-store(由 api.ts 统一设置)
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';

import type { DshLoginUrl } from '../../src/shared/types.ts';
import { ApiError, type Route } from '../api.ts';

/** 与 /root/dsh-login-url.sh 保持一致的字符集 */
const TOKEN_PATTERN = /token=([A-Za-z0-9_-]+)/g;

/** 校验结果的短缓存:避免连点把本地 dsh 打爆(不改变"新 token 必然重新校验"的行为) */
const CACHE_MS = 5_000;

export interface DshRouteDeps {
  /** pm2 日志目录,例如 /root/.pm2/logs */
  logDir: string;
  /** 日志文件名前缀,例如 dsh-out */
  logPrefix: string;
  /** 对外 host(同时用作校验请求的 Host 头) */
  publicHost: string;
  /** 本机 dsh web 端口 */
  port: number;
  /** 可注入的校验函数:返回 HTTP 状态码(测试用) */
  validate?: (token: string) => Promise<number>;
}

export type { DshLoginUrl };

export interface TokenHit {
  token: string;
  source: string;
}

/**
 * 在所有匹配的日志文件里找**最后一条** token。
 * 按 mtime 从新到旧扫描,一旦某个文件里有 token 就返回(新文件里的才可能是当前进程的)。
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
      continue;
    }
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

/** 用带受信 Host 头的请求换取 303,确认 token 仍属于当前进程。 */
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
        res.resume(); // 丢弃响应体,不保留 cookie
        resolve(res.statusCode ?? 0);
      },
    );
    req.setTimeout(5000, () => req.destroy(new Error('校验请求超时')));
    req.on('error', reject);
    req.end();
  });
}

export function dshRoute(deps: DshRouteDeps): Route {
  const validate = deps.validate ?? ((token: string) => httpValidate(deps.port, deps.publicHost, token));
  let cache: { token: string; valid: boolean; at: number } | undefined;

  return {
    method: 'GET',
    path: '/api/dsh/login-url',
    auth: true,
    handle: async (ctx) => {
      const hit = await findLatestToken(deps.logDir, deps.logPrefix);
      if (hit === null) {
        throw new ApiError(
          503,
          'token_not_found',
          `未在 ${deps.logDir}/${deps.logPrefix}* 找到 token,dsh web 可能没在 pm2 下运行`,
        );
      }

      const now = Date.now();
      let valid: boolean;
      if (cache !== undefined && cache.token === hit.token && now - cache.at < CACHE_MS) {
        valid = cache.valid;
      } else {
        let status: number;
        try {
          status = await validate(hit.token);
        } catch (error) {
          throw new ApiError(502, 'validate_failed', `无法校验 token:${(error as Error).message}`);
        }
        valid = status === 303;
        cache = { token: hit.token, valid, at: now };
      }

      ctx.log.info('dsh login url issued', {
        tokenPrefix: hit.token.slice(0, 8),
        valid,
        source: hit.source,
        ip: ctx.ip,
      });

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
