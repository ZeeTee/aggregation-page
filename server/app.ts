/**
 * HTTP 服务组装:把静态托管、/api 路由、限流、安全头、日志接在一起。
 *
 * 与入口(index.ts)分离是为了**可测试**:测试里可以用临时端口直接起这个 server。
 * 限流与鉴权都在路由层决策(它才知道命中哪条路由、是否需要密钥)。
 */

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { createApiRouter } from './api.ts';
import type { Logger } from './log.ts';
import { buildRoutes, type RouteDeps } from './routes/index.ts';
import { FailureBudget, RateLimiter, applySecurityHeaders, clientIp } from './security.ts';
import { serveStatic } from './static.ts';

export interface AppOptions {
  distDir: string;
  version: string;
  log: Logger;
  /** 每个 IP 每分钟的 /api 请求上限(普通接口) */
  apiRateLimit?: number;
  /** 需要鉴权的接口的独立上限(应更严格) */
  authRateLimit?: number;
  /** 全局鉴权失败预算 */
  authFailureBudget?: number;
  /** 共享密钥;缺省或空字符串表示未配置(需要鉴权的接口会 503) */
  apiKey?: string;
  toolsCount: () => number;
  /** DSH 地址接口配置 */
  dsh: RouteDeps['dsh'];
  /** DSH 重启接口配置(有副作用,带冷却) */
  dshRestart: RouteDeps['dshRestart'];
  /** 手工新闻队列接口配置(数据来自 ai-news-daily) */
  news: RouteDeps['news'];
  /** 自定义 404 页面路径(通常 dist/404.html) */
  notFoundPage?: string;
}

export function createApp(options: AppOptions): Server {
  const deps: RouteDeps = {
    version: options.version,
    distDir: options.distDir,
    toolsCount: options.toolsCount,
    dsh: options.dsh,
    dshRestart: options.dshRestart,
    news: options.news,
  };
  const apiRouter = createApiRouter(buildRoutes(deps), {
    log: options.log,
    rateLimiter: new RateLimiter(options.apiRateLimit ?? 60),
    authRateLimiter: new RateLimiter(options.authRateLimit ?? 5),
    authFailureBudget: new FailureBudget(options.authFailureBudget ?? 10),
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
  });
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
      if (await apiRouter(req, res, url, ip)) {
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
