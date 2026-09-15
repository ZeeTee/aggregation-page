/**
 * 服务端测试:纯函数的边界 + 用临时产物目录跑真实 HTTP 请求。
 *
 * 集成部分在自己的临时 dist/ 上跑,不依赖项目是否已构建,可离线重复执行。
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../server/app.ts';
import { loadEnvFile, readServerEnv } from '../server/env.ts';
import { createLogger } from '../server/log.ts';
import { RateLimiter, SECURITY_HEADERS, clientIp } from '../server/security.ts';
import { cacheControlFor, contentTypeFor, resolveWithin, weakEtag } from '../server/static.ts';

/** 造一个最小的构建产物目录 */
function makeDist(): string {
  const dist = mkdtempSync(join(tmpdir(), 'agg-dist-'));
  writeFileSync(join(dist, 'index.html'), '<!DOCTYPE html><html><body>home</body></html>');
  writeFileSync(join(dist, 'tools.json'), JSON.stringify({ count: 1, tools: [] }));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'assets', 'app-abc123.css'), 'body{color:red}');
  return dist;
}

const silent = createLogger('error', () => undefined);

async function withApp(
  options: Partial<Parameters<typeof createApp>[0]>,
  run: (base: string) => Promise<void>,
  rateLimit = 100,
): Promise<void> {
  const distDir = options.distDir ?? makeDist();
  const server: Server = createApp({
    distDir,
    version: 'test',
    log: silent,
    apiRateLimit: rateLimit,
    toolsCount: () => 1,
    // 多数用例不关心 DSH 接口,给一份指向空目录的默认配置
    dsh: {
      logDir: mkdtempSync(join(tmpdir(), 'agg-no-logs-')),
      logPrefix: 'dsh-out',
      publicHost: 'dsh.example.com',
      port: 3080,
    },
    // 重启接口:默认注入一个"不会真的执行"的执行器
    dshRestart: {
      pm2Bin: '/nonexistent/pm2',
      appName: 'dsh',
      pm2Home: '/tmp',
      cooldownSeconds: 60,
      run: async () => ({ ok: true, detail: 'stub' }),
    },
    ...options,
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

describe('静态路径解析(resolveWithin)', () => {
  const root = '/srv/site/dist';

  it('正常路径解析到 root 之内', () => {
    expect(resolveWithin(root, '/index.html')).toBe('/srv/site/dist/index.html');
    expect(resolveWithin(root, '/tools/abc/')).toBe('/srv/site/dist/tools/abc');
    expect(resolveWithin(root, '/')).toBe('/srv/site/dist');
  });

  it('挡住目录穿越', () => {
    expect(resolveWithin(root, '/../package.json')).toBeNull();
    expect(resolveWithin(root, '/../../etc/passwd')).toBeNull();
    expect(resolveWithin(root, '/%2e%2e%2fpackage.json')).toBeNull(); // 段内编码斜杠
    expect(resolveWithin(root, '/..%2fsecret')).toBeNull();
  });

  it('挡住非法输入', () => {
    expect(resolveWithin(root, '/a%00b')).toBeNull(); // NUL
    expect(resolveWithin(root, '/%ZZ')).toBeNull(); // 非法百分号编码
  });

  it('前缀相同的兄弟目录不算越界', () => {
    // /srv/site/dist-evil 不能因为字符串前缀相同就被放行
    expect(resolveWithin(root, '/../dist-evil/x')).toBeNull();
  });
});

describe('响应头策略', () => {
  it('哈希资源长缓存,文档类不缓存', () => {
    expect(cacheControlFor('/assets/app-abc123.css')).toContain('immutable');
    expect(cacheControlFor('/index.html')).toContain('no-cache');
    expect(cacheControlFor('/tools.json')).toContain('no-cache');
    expect(cacheControlFor('/cover.png')).toContain('max-age=86400');
  });

  it('按扩展名给出 MIME', () => {
    expect(contentTypeFor('a.html')).toContain('text/html');
    expect(contentTypeFor('a.css')).toContain('text/css');
    expect(contentTypeFor('a.js')).toContain('javascript');
    expect(contentTypeFor('a.woff2')).toBe('font/woff2');
    expect(contentTypeFor('a.unknown')).toBe('application/octet-stream');
  });

  it('ETag 由大小与修改时间决定', () => {
    expect(weakEtag(1234, 1_700_000_000_000)).toBe(weakEtag(1234, 1_700_000_000_000));
    expect(weakEtag(1234, 1)).not.toBe(weakEtag(1235, 1));
  });

  it('安全头齐备', () => {
    expect(SECURITY_HEADERS['X-Content-Type-Options']).toBe('nosniff');
    expect(SECURITY_HEADERS['Referrer-Policy']).toBe('no-referrer');
    expect(SECURITY_HEADERS['Content-Security-Policy']).toContain("frame-ancestors 'none'");
  });
});

describe('限流与客户端 IP', () => {
  it('固定窗口内超过上限即拒绝,窗口重置后恢复', () => {
    const limiter = new RateLimiter(3, 1000);
    expect(limiter.allow('1.2.3.4', 0)).toBe(true);
    expect(limiter.allow('1.2.3.4', 1)).toBe(true);
    expect(limiter.allow('1.2.3.4', 2)).toBe(true);
    expect(limiter.allow('1.2.3.4', 3)).toBe(false);
    expect(limiter.allow('5.6.7.8', 3)).toBe(true); // 其它 IP 不受影响
    expect(limiter.allow('1.2.3.4', 1001)).toBe(true); // 窗口已重置
  });

  it('Retry-After 为正数', () => {
    const limiter = new RateLimiter(1, 60_000);
    limiter.allow('ip', 0);
    limiter.allow('ip', 1);
    expect(limiter.retryAfterSeconds('ip', 1)).toBeGreaterThan(0);
  });

  it('优先取 CF-Connecting-IP,其次 X-Forwarded-For 的第一段', () => {
    expect(clientIp({ 'cf-connecting-ip': '9.9.9.9', 'x-forwarded-for': '1.1.1.1' }, '127.0.0.1')).toBe('9.9.9.9');
    expect(clientIp({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }, '127.0.0.1')).toBe('1.1.1.1');
    expect(clientIp({}, '127.0.0.1')).toBe('127.0.0.1');
  });
});

describe('环境变量', () => {
  it('loadEnvFile 不覆盖已有变量', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agg-env-'));
    const file = join(dir, '.env');
    writeFileSync(file, '# 注释\nPORT=9999\nQUOTED="hello world"\nEMPTY=\n');
    const env: NodeJS.ProcessEnv = { PORT: '1111' };
    expect(loadEnvFile(file, env)).toBe(2);
    expect(env['PORT']).toBe('1111');
    expect(env['QUOTED']).toBe('hello world');
    expect(env['EMPTY']).toBe('');
  });

  it('非法数字回退默认值', () => {
    const env = readServerEnv('/tmp', { PORT: 'abc', API_RATE_LIMIT: '-5', LOG_LEVEL: 'nope' });
    expect(env.port).toBe(8080);
    expect(env.apiRateLimit).toBe(60);
    expect(env.logLevel).toBe('info');
    expect(env.host).toBe('127.0.0.1');
  });
});

describe('HTTP 集成', () => {
  let distDir = '';

  beforeAll(() => {
    distDir = makeDist();
  });

  it('静态页面:200 + no-cache + 安全头', async () => {
    await withApp({ distDir }, async (base) => {
      const res = await fetch(`${base}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('home');
      expect(res.headers.get('cache-control')).toContain('no-cache');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    });
  });

  it('哈希资源:200 + 长缓存 + ETag 命中 304', async () => {
    await withApp({ distDir }, async (base) => {
      const first = await fetch(`${base}/assets/app-abc123.css`);
      expect(first.status).toBe(200);
      expect(first.headers.get('cache-control')).toContain('immutable');
      const etag = first.headers.get('etag');
      expect(etag).toBeTruthy();

      const second = await fetch(`${base}/assets/app-abc123.css`, {
        headers: { 'If-None-Match': etag! },
      });
      expect(second.status).toBe(304);
      await second.arrayBuffer();
    });
  });

  it('不存在的路径 404;目录穿越 403', async () => {
    await withApp({ distDir }, async (base) => {
      expect((await fetch(`${base}/nope.html`)).status).toBe(404);
      const esc = await fetch(`${base}/%2e%2e%2fpackage.json`);
      expect(esc.status).toBe(403);
      await esc.arrayBuffer();
    });
  });

  it('/api/health 返回 ok 信封', async () => {
    await withApp({ distDir }, async (base) => {
      const res = await fetch(`${base}/api/health`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const payload = (await res.json()) as { ok: boolean; data: { status: string; tools: number } };
      expect(payload.ok).toBe(true);
      expect(payload.data.status).toBe('ok');
      expect(payload.data.tools).toBe(1);
    });
  });

  it('/api/tools 回显构建产物;缺失时 503', async () => {
    await withApp({ distDir }, async (base) => {
      const payload = (await (await fetch(`${base}/api/tools`)).json()) as { ok: boolean };
      expect(payload.ok).toBe(true);
    });
    await withApp({ distDir: mkdtempSync(join(tmpdir(), 'agg-empty-')) }, async (base) => {
      const res = await fetch(`${base}/api/tools`);
      expect(res.status).toBe(503);
      await res.arrayBuffer();
    });
  });

  it('接口的错误分支:404 / 405 / 415 / 400 / 413', async () => {
    await withApp({ distDir }, async (base) => {
      expect((await fetch(`${base}/api/nope`)).status).toBe(404);
      expect((await fetch(`${base}/api/echo`)).status).toBe(405);

      const wrongType = await fetch(`${base}/api/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'hi',
      });
      expect(wrongType.status).toBe(415);

      const badJson = await fetch(`${base}/api/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{oops',
      });
      expect(badJson.status).toBe(400);

      const tooBig = await fetch(`${base}/api/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x: 'a'.repeat(70_000) }),
      });
      expect(tooBig.status).toBe(413);
      await tooBig.arrayBuffer();
    });
  });

  it('POST /api/echo 正常回显', async () => {
    await withApp({ distDir }, async (base) => {
      const res = await fetch(`${base}/api/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
      });
      expect(res.status).toBe(200);
      const payload = (await res.json()) as { ok: boolean; data: { received: { hello: string } } };
      expect(payload.data.received.hello).toBe('world');
    });
  });

  it('限流只作用于 /api,超限返回 429 + Retry-After', async () => {
    await withApp(
      { distDir },
      async (base) => {
        const codes: number[] = [];
        for (let i = 0; i < 5; i += 1) {
          const res = await fetch(`${base}/api/health`);
          codes.push(res.status);
          await res.arrayBuffer();
        }
        expect(codes.filter((c) => c === 429)).toHaveLength(3);
        const limited = await fetch(`${base}/api/health`);
        expect(limited.headers.get('retry-after')).toBeTruthy();
        await limited.arrayBuffer();

        // 静态资源不受影响
        const page = await fetch(`${base}/`);
        expect(page.status).toBe(200);
        await page.arrayBuffer();
      },
      2,
    );
  });
});

afterAll(() => {
  /* 临时目录交给系统回收 */
});
