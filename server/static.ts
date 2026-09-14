/**
 * 静态文件托管。
 *
 * 关键点:
 *   1. **路径穿越防护**:解析后的绝对路径必须落在 dist/ 之内,否则 403
 *   2. 目录访问补 index.html
 *   3. 分级缓存:带内容哈希的 /assets/* 长缓存 + immutable;HTML/JSON 走 no-cache
 *   4. ETag + If-None-Match → 304
 *   5. 不做压缩:交给 Cloudflare 边缘自动 gzip/brotli
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export function contentTypeFor(filePath: string): string {
  return MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * 把 URL 路径解析成 dist/ 内的绝对文件路径。
 * 越界(目录穿越)、含 NUL 字节、解析到根目录之外 → 返回 null。
 */
export function resolveWithin(root: string, urlPath: string): string | null {
  const rootAbs = resolve(root);
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // 非法百分号编码
  }
  // NUL 字节要在**解码之后**再查一次(否则 %00 能绕过)
  if (decoded.includes('\0')) return null;
  const relative = decoded.replace(/^\/+/, '');
  const full = resolve(rootAbs, relative);
  if (full !== rootAbs && !full.startsWith(rootAbs + sep)) return null;
  return full;
}

/** 分级缓存策略:哈希资源长缓存,文档类每次校验。 */
export function cacheControlFor(urlPath: string): string {
  if (urlPath.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  if (/\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf)$/i.test(urlPath)) return 'public, max-age=86400';
  return 'no-cache, must-revalidate';
}

/** 由文件大小与修改时间生成弱 ETag。 */
export function weakEtag(size: number, mtimeMs: number): string {
  return `W/"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
}

export interface StaticResult {
  status: number;
  /** 命中文件时的绝对路径(便于日志排查) */
  file?: string;
}

export interface StaticOptions {
  root: string;
  /** 自定义 404 页面(dist/404.html);缺省时返回极简文本 */
  notFoundPage?: string;
}

function sendPlain(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  urlPath: string,
  size: number,
  mtimeMs: number,
): Promise<void> {
  const etag = weakEtag(size, mtimeMs);
  const inm = req.headers['if-none-match'];
  if (typeof inm === 'string' && inm.split(',').some((v) => v.trim() === etag)) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': cacheControlFor(urlPath) });
    res.end();
    return;
  }

  res.writeHead(200, {
    'Content-Type': contentTypeFor(file),
    'Content-Length': String(size),
    ETag: etag,
    'Last-Modified': new Date(mtimeMs).toUTCString(),
    'Cache-Control': cacheControlFor(urlPath),
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  await new Promise<void>((done) => {
    const stream = createReadStream(file);
    stream.on('error', () => {
      if (!res.headersSent) sendPlain(res, 500, 'Internal Server Error');
      else res.destroy();
      done();
    });
    stream.on('close', done);
    stream.pipe(res);
  });
}

/** 处理一次静态请求并写完响应,返回状态码(供日志使用)。 */
export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  urlPath: string,
  options: StaticOptions,
): Promise<StaticResult> {
  const target = resolveWithin(options.root, urlPath);
  if (target === null) {
    sendPlain(res, 403, 'Forbidden');
    return { status: 403 };
  }

  let file = target;
  try {
    let info = await stat(file);
    if (info.isDirectory()) {
      file = resolve(file, 'index.html');
      info = await stat(file);
    }
    if (!info.isFile()) throw new Error('not a file');
    await sendFile(req, res, file, urlPath, info.size, info.mtimeMs);
    return { status: res.statusCode, file };
  } catch {
    if (options.notFoundPage !== undefined) {
      try {
        const info = await stat(options.notFoundPage);
        await sendFile(req, res, options.notFoundPage, '/404.html', info.size, info.mtimeMs);
        res.statusCode = 404;
        return { status: 404 };
      } catch {
        /* 落到默认 404 */
      }
    }
    if (!res.headersSent) {
      res.setHeader('Cache-Control', 'no-cache');
      sendPlain(res, 404, '404 Not Found');
    }
    return { status: 404 };
  }
}
