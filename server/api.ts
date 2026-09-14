/**
 * /api 路由层:统一响应信封、请求体限制、超时、错误处理。
 *
 * 响应格式(前后端共享类型见 src/shared/types.ts):
 *   成功 { ok: true,  data: ... }
 *   失败 { ok: false, error: { code, message } }
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Logger } from './log.ts';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface ApiContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  query: URLSearchParams;
  /** 已解析的 JSON 请求体(GET 为 undefined) */
  body: unknown;
  ip: string;
  log: Logger;
}

export type ApiHandler = (ctx: ApiContext) => Promise<unknown>;

export interface Route {
  method: HttpMethod;
  /** 精确路径,例如 '/api/health' */
  path: string;
  handle: ApiHandler;
}

/** 业务错误:带上 HTTP 状态码与错误码,响应体不会泄漏内部细节。
 *
 * 注意:这里不用「构造器参数属性」(constructor(readonly x))——
 * Node 的类型剥离(strip-only)不支持该语法,而开发期是直接跑 .ts 的。
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export interface ApiRouterOptions {
  log: Logger;
  /** 请求体上限,默认 64KB */
  maxBodyBytes?: number;
  /** 单请求超时,默认 10s */
  timeoutMs?: number;
}

const DEFAULT_MAX_BODY = 64 * 1024;
const DEFAULT_TIMEOUT = 10_000;

function send(res: ServerResponse, status: number, payload: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

export function ok(res: ServerResponse, data: unknown, status = 200): void {
  send(res, status, { ok: true, data });
}

export function fail(res: ServerResponse, status: number, code: string, message: string, extraHeaders: Record<string, string> = {}): void {
  send(res, status, { ok: false, error: { code, message } }, extraHeaders);
}

/** 读取请求体,超过上限抛 413。 */
async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.byteLength;
    if (total > maxBytes) {
      throw new ApiError(413, 'payload_too_large', `请求体超过上限(${maxBytes} 字节)`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ApiError(504, 'timeout', '处理超时')), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 创建路由分发器。返回的函数处理 /api 请求并返回 true;非 /api 路径返回 false。
 */
export function createApiRouter(
  routes: readonly Route[],
  options: ApiRouterOptions,
): (req: IncomingMessage, res: ServerResponse, url: URL, ip: string) => Promise<boolean> {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
  const { log } = options;

  return async (req, res, url, ip): Promise<boolean> => {
    const path = url.pathname;
    if (path !== '/api' && !path.startsWith('/api/')) return false;

    const method = (req.method ?? 'GET').toUpperCase() as HttpMethod;

    // 先按路径分组,便于区分 404(无此接口)与 405(方法不对)
    const byPath = routes.filter((r) => r.path === path);
    if (byPath.length === 0) {
      fail(res, 404, 'not_found', `未知接口:${path}`);
      return true;
    }
    const route = byPath.find((r) => r.method === method);
    if (route === undefined) {
      fail(res, 405, 'method_not_allowed', `${path} 不支持 ${method}`, {
        Allow: byPath.map((r) => r.method).join(', '),
      });
      return true;
    }

    try {
      let body: unknown;
      if (method !== 'GET') {
        const raw = await readBody(req, maxBodyBytes);
        if (raw.byteLength > 0) {
          const contentType = String(req.headers['content-type'] ?? '');
          if (!contentType.includes('application/json')) {
            throw new ApiError(415, 'unsupported_media_type', '请求体必须是 application/json');
          }
          try {
            body = JSON.parse(raw.toString('utf8'));
          } catch {
            throw new ApiError(400, 'invalid_json', 'JSON 解析失败');
          }
        }
      }

      const data = await withTimeout(
        route.handle({ req, res, url, query: url.searchParams, body, ip, log }),
        timeoutMs,
      );
      if (!res.writableEnded) ok(res, data ?? null);
    } catch (error) {
      if (res.writableEnded) return true;
      if (error instanceof ApiError) {
        fail(res, error.status, error.code, error.message);
      } else {
        // 内部错误:记录堆栈,但只回固定文案
        log.error('api handler failed', {
          path,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        fail(res, 500, 'internal_error', '服务器内部错误');
      }
    }
    return true;
  };
}
