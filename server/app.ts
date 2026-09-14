/**
 * HTTP 服务组装:把静态托管、/api 路由、限流、安全头、日志接在一起。
 *
 * 与入口(index.ts)分离是为了**可测试**:测试里可以用临时端口直接起这个 server。
 */

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { createApiRouter, fail } from './api.ts';
import type { Logger } from './log.ts';
import { buildRoutes } from './routes/index.ts';
import { RateLimiter, applySecurityHeaders, clientIp } from './security.ts';
import { serveStatic } from './static.ts';

export interface AppOptions {
  distDir: string;
  version: string;
  log: Logger;
  /** 每个 IP 每分钟的 /api 请求上限 */
  apiRateLimit?: number;
  toolsCount: () => number;
  /** 自定义 404 页面路径(通常 dist/404.html) */
  notFoundPage?: string;
}

export function createApp(options: AppOptions): Server {
  const apiRouter = createApiRouter(
    buildRoutes({ version: options.version, distDir: options.distDir, toolsCount: options.toolsCount }),
    { log: options.log },
  );
  const limiter = new RateLimiter(options.apiRateLimit ?? 60);
  const staticOptions = {
    root: options.distDir,
    ...(options.notFoundPage !== undefined ? { notFoundPage: options.notFoundPage } : {}),
  };

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAt = performance.now();
    const id = randomUUID().slice(0, 8);
    const ip = clientIp(req.headers, req.socket.remoteAddress);
    const { log } = options;

    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return;
    }

    applySecurityHeaders(res);

    try {
      const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
      if (isApi && !limiter.allow(ip)) {
        fail(res, 429, 'rate_limited', '请求过于频繁,请稍后再试', {
          'Retry-After': String(limiter.retryAfterSeconds(ip)),
        });
      } else if (await apiRouter(req, res, url, ip)) {
        /* 路由层已写完响应 */
      } else {
        await serveStatic(req, res, url.pathname, staticOptions);
      }
    } catch (error) {
      log.error('请求处理异常', {
        id,
        path: url.pathname,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Internal Server Error');
      } else {
        res.destroy();
      }
    } finally {
      log.request({
        id,
        method: req.method ?? 'GET',
        path: url.pathname,
        status: res.statusCode,
        ms: Math.round(performance.now() - startedAt),
        ip,
        ...(typeof req.headers['cf-ray'] === 'string' ? { cfRay: req.headers['cf-ray'] } : {}),
        ...(typeof req.headers['user-agent'] === 'string' ? { userAgent: req.headers['user-agent'] } : {}),
      });
    }
  }

  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return server;
}
