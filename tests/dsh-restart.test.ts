/**
 * 重启接口(POST /api/dsh/restart)的服务端测试。
 *
 * 这是站内唯一有副作用的接口,所以测试重点不是"能不能重启",而是**护栏**:
 *   1. 没密钥 / 密钥错 → 绝不能执行命令(执行器一次都不能被调用)
 *   2. 冷却生效 → 短时间内第二次请求被拒(防止被反复触发把 dsh 打进重启循环)
 *   3. 失败不进入冷却 → pm2 报错后应允许立即重试
 *   4. 命令是常量 → 调用方传什么(query/body)都改变不了执行器拿到的参数
 *   5. mock 模式下不依赖真实 pm2(测试永远不会真的重启 dsh)
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../server/app.ts';
import { createLogger } from '../server/log.ts';

const silent = createLogger('error', () => undefined);
const KEY = '521016';

function makeDist(): string {
  const dist = mkdtempSync(join(tmpdir(), 'agg-dist-'));
  writeFileSync(join(dist, 'index.html'), '<!DOCTYPE html><html><body>home</body></html>');
  writeFileSync(join(dist, 'tools.json'), JSON.stringify({ count: 1, tools: [] }));
  return dist;
}

interface Harness {
  base: string;
  run: ReturnType<typeof vi.fn>;
  close: () => Promise<void>;
}

async function start(options: {
  apiKey?: string;
  cooldownSeconds?: number;
  runResult?: { ok: boolean; detail: string };
  now?: () => number;
} = {}): Promise<Harness> {
  const run = vi.fn(async () => options.runResult ?? { ok: true, detail: 'stub ok' });
  const server: Server = createApp({
    distDir: makeDist(),
    version: 'test',
    log: silent,
    apiKey: options.apiKey ?? KEY,
    toolsCount: () => 1,
    dsh: {
      logDir: mkdtempSync(join(tmpdir(), 'agg-logs-')),
      logPrefix: 'dsh-out',
      publicHost: 'dsh.example.com',
      port: 3080,
    },
    dshRestart: {
      pm2Bin: '/nonexistent/pm2', // 注入了 run,不会去检查这个路径
      appName: 'dsh',
      pm2Home: '/tmp',
      cooldownSeconds: options.cooldownSeconds ?? 60,
      run,
      ...(options.now !== undefined ? { now: options.now } : {}),
    },
    news: {
      pythonBin: '/nonexistent/python3',
      projectDir: '/tmp',
      fetchTimeoutSeconds: 5,
      addCooldownSeconds: 0,
      run: async () => ({ code: 0, stdout: '{"ok":true,"entries":[]}', stderr: '' }),
    },
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    run,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

const post = (base: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${base}/api/dsh/restart`, { method: 'POST', headers });

describe('重启接口:鉴权与命令白名单', () => {
  it('不带密钥 → 401,且执行器一次都没被调用', async () => {
    const app = await start();
    try {
      const res = await post(app.base);
      expect(res.status).toBe(401);
      const text = await res.text();
      expect(JSON.parse(text)).toMatchObject({ error: { code: 'unauthorized' } });
      expect(app.run).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('密钥错误 → 401,执行器不被调用', async () => {
    const app = await start();
    try {
      const res = await post(app.base, { 'X-Api-Key': '000000' });
      expect(res.status).toBe(401);
      expect(app.run).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('服务端未配置密钥 → 503(fail-closed)', async () => {
    const app = await start({ apiKey: '' });
    try {
      const res = await post(app.base, { 'X-Api-Key': KEY });
      expect(res.status).toBe(503);
      const payload = (await res.json()) as { error: { code: string } };
      expect(payload.error.code).toBe('api_key_not_configured');
      expect(app.run).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('密钥正确 → 执行一次,且参数只有常量(pm2 路径 + 应用名)', async () => {
    const app = await start();
    try {
      // 故意在 query / body 里塞东西,验证它们不会进入命令
      const res = await fetch(
        `${app.base}/api/dsh/restart?cmd=rm+-rf+/&app=evil`,
        {
          method: 'POST',
          headers: { 'X-Api-Key': KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ pm2Bin: '/bin/sh', appName: '; reboot' }),
        },
      );
      expect(res.status).toBe(200);
      const payload = (await res.json()) as {
        ok: boolean;
        data: { restarted: boolean; appName: string; tookMs: number; note: string };
      };
      expect(payload.ok).toBe(true);
      expect(payload.data.restarted).toBe(true);
      expect(payload.data.appName).toBe('dsh');
      expect(payload.data.note).toContain('旧登录地址');

      expect(app.run).toHaveBeenCalledTimes(1);
      expect(app.run).toHaveBeenCalledWith('/nonexistent/pm2', 'dsh');
    } finally {
      await app.close();
    }
  });

  it('GET 不允许(405)', async () => {
    const app = await start();
    try {
      const res = await fetch(`${app.base}/api/dsh/restart`, { headers: { 'X-Api-Key': KEY } });
      expect(res.status).toBe(405);
      expect(app.run).not.toHaveBeenCalled();
      await res.arrayBuffer();
    } finally {
      await app.close();
    }
  });
});

describe('重启接口:冷却', () => {
  it('冷却窗口内第二次请求被拒(429 + Retry-After),执行器只跑了一次', async () => {
    let clock = 1_000_000;
    const app = await start({ cooldownSeconds: 60, now: () => clock });
    try {
      const first = await post(app.base, { 'X-Api-Key': KEY });
      expect(first.status).toBe(200);
      await first.arrayBuffer();

      const second = await post(app.base, { 'X-Api-Key': KEY });
      expect(second.status).toBe(429);
      expect(second.headers.get('retry-after')).toBeTruthy();
      const payload = (await second.json()) as { error: { code: string; message: string } };
      expect(payload.error.code).toBe('restart_cooldown');
      expect(payload.error.message).toMatch(/秒后再试/);
      expect(app.run).toHaveBeenCalledTimes(1);

      // 时钟走过冷却期 → 允许再次重启
      clock += 61_000;
      const third = await post(app.base, { 'X-Api-Key': KEY });
      expect(third.status).toBe(200);
      await third.arrayBuffer();
      expect(app.run).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it('cooldownSeconds=0 表示不限制(但仍逐次执行)', async () => {
    const app = await start({ cooldownSeconds: 0 });
    try {
      expect((await post(app.base, { 'X-Api-Key': KEY })).status).toBe(200);
      expect((await post(app.base, { 'X-Api-Key': KEY })).status).toBe(200);
      expect(app.run).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
});

describe('重启接口:失败处理', () => {
  it('pm2 执行失败 → 502,且**不**进入冷却(可立即重试)', async () => {
    const app = await start({ runResult: { ok: false, detail: 'pm2: command failed' } });
    try {
      const res = await post(app.base, { 'X-Api-Key': KEY });
      expect(res.status).toBe(502);
      const payload = (await res.json()) as { error: { code: string; message: string } };
      expect(payload.error.code).toBe('restart_failed');
      // 失败详情只进日志,不回给调用方
      expect(payload.error.message).not.toContain('command failed');
      expect((await post(app.base, { 'X-Api-Key': KEY })).status).toBe(502);
      expect(app.run).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it('pm2 路径不存在(未注入执行器时)→ 503 pm2_not_found', async () => {
    const server: Server = createApp({
      distDir: makeDist(),
      version: 'test',
      log: silent,
      apiKey: KEY,
      toolsCount: () => 1,
      dsh: {
        logDir: mkdtempSync(join(tmpdir(), 'agg-logs-')),
        logPrefix: 'dsh-out',
        publicHost: 'dsh.example.com',
        port: 3080,
      },
      dshRestart: {
        pm2Bin: '/definitely/not/here/pm2',
        appName: 'dsh',
        pm2Home: '/tmp',
        cooldownSeconds: 60,
        // 注意:不注入 run → 走默认真实执行器路径,会先做存在性检查
      },
      news: {
        pythonBin: '/nonexistent/python3',
        projectDir: '/tmp',
        fetchTimeoutSeconds: 5,
        addCooldownSeconds: 0,
        run: async () => ({ code: 0, stdout: '{"ok":true,"entries":[]}', stderr: '' }),
      },
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/dsh/restart`, {
        method: 'POST',
        headers: { 'X-Api-Key': KEY },
      });
      expect(res.status).toBe(503);
      const payload = (await res.json()) as { error: { code: string } };
      expect(payload.error.code).toBe('pm2_not_found');
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});
