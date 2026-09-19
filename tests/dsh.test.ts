/**
 * DSH 登录地址接口 + 共享密钥鉴权的测试。
 *
 * 重点是三类风险:
 *   1. 凭据泄漏:未授权请求绝不能拿到 token(响应体里连片段都不能有)
 *   2. 爆破:错误密钥要被限流/失败预算挡住
 *   3. 失效识别:dsh 重启后 token 不再返回 303,必须标记 valid:false
 */

import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createApp } from '../server/app.ts';
import type { ApiContext } from '../server/api.ts';
import { createLogger } from '../server/log.ts';
import { FailureBudget, apiKeyMatches } from '../server/security.ts';
import { dshRoute, findLatestToken } from '../server/routes/dsh.ts';

const silent = createLogger('error', () => undefined);
const KEY = '521016';

function makeDist(): string {
  const dist = mkdtempSync(join(tmpdir(), 'agg-dist-'));
  writeFileSync(join(dist, 'index.html'), '<!DOCTYPE html><html><body>home</body></html>');
  writeFileSync(join(dist, 'tools.json'), JSON.stringify({ count: 1, tools: [] }));
  return dist;
}

function makeLogDir(files: Record<string, string>, mtimes?: Record<string, number>): string {
  const dir = mkdtempSync(join(tmpdir(), 'agg-pm2-'));
  for (const [name, content] of Object.entries(files)) {
    const file = join(dir, name);
    writeFileSync(file, content);
    const when = mtimes?.[name];
    if (when !== undefined) {
      // 通过 utimes 设定修改时间,用于验证"按时间取最新文件"
      const seconds = when / 1000;
      utimesSync(file, seconds, seconds);
    }
  }
  return dir;
}

async function withApp(
  options: Partial<Parameters<typeof createApp>[0]>,
  run: (base: string) => Promise<void>,
): Promise<void> {
  const server: Server = createApp({
    distDir: makeDist(),
    version: 'test',
    log: silent,
    toolsCount: () => 1,
    apiKey: KEY,
    dsh: { logDir: makeLogDir({}), logPrefix: 'dsh-out', publicHost: 'dsh.example.com', port: 3080 },
    dshRestart: {
      pm2Bin: '/nonexistent/pm2',
      appName: 'dsh',
      pm2Home: '/tmp',
      cooldownSeconds: 60,
      run: async () => ({ ok: true, detail: 'stub' }),
    },
    news: {
      pythonBin: '/nonexistent/python3',
      projectDir: '/tmp',
      fetchTimeoutSeconds: 5,
      addCooldownSeconds: 0,
      run: async () => ({ code: 0, stdout: '{"ok":true,"entries":[]}', stderr: '' }),
    },
dshUpdate: {
      npmBin: '/nonexistent/npm',
      dshPackage: '@deepseek-ai/dsh',
      dshModuleDir: '/tmp',
      patchScript: '/nonexistent/patch.sh',
      patchHost: 'dsh.example.com',
      stateFile: '/tmp/dsh-update.json',
      pm2Bin: '/nonexistent/pm2',
      appName: 'dsh',
      pm2Home: '/tmp',
      dsh: { logDir: '/tmp', logPrefix: 'dsh-out', publicHost: 'dsh.example.com', port: 3080 },
      run: async () => ({ code: 0, stdout: '{}', stderr: '' }),
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

describe('共享密钥比较', () => {
  it('相等才通过', () => {
    expect(apiKeyMatches('521016', '521016')).toBe(true);
    expect(apiKeyMatches('521017', '521016')).toBe(false);
    expect(apiKeyMatches('52101', '521016')).toBe(false); // 长度不同
    expect(apiKeyMatches('', '521016')).toBe(false);
    expect(apiKeyMatches(undefined, '521016')).toBe(false);
  });

  it('未配置密钥时任何输入都不通过(fail-closed)', () => {
    expect(apiKeyMatches('', '')).toBe(false);
    expect(apiKeyMatches('anything', '')).toBe(false);
  });
});

describe('失败预算(防分布式爆破)', () => {
  it('累计失败达到上限后整体冷却,冷却结束自动恢复', () => {
    const budget = new FailureBudget(3, 1000, 5000);
    expect(budget.blocked(0)).toBe(false);
    budget.recordFailure(0);
    budget.recordFailure(10);
    expect(budget.blocked(20)).toBe(false);
    budget.recordFailure(20); // 第 3 次 → 触发冷却
    expect(budget.blocked(21)).toBe(true);
    expect(budget.retryAfterSeconds(21)).toBeGreaterThan(0);
    expect(budget.blocked(6000)).toBe(false); // 冷却结束
  });

  it('窗口外的旧失败不计入', () => {
    const budget = new FailureBudget(2, 1000, 5000);
    budget.recordFailure(0);
    budget.recordFailure(5000); // 第一条已过期
    expect(budget.blocked(5001)).toBe(false);
  });
});

describe('从 pm2 日志里找 token', () => {
  const line = (token: string): string => `dsh web: http://127.0.0.1:3080/?token=${token}\n`;

  it('取最后一条 token(同一文件内)', async () => {
    const dir = makeLogDir({ 'dsh-out.log': line('FIRST_aaa') + line('SECOND_bbb') });
    const hit = await findLatestToken(dir, 'dsh-out');
    expect(hit?.token).toBe('SECOND_bbb');
    expect(hit?.source).toBe('dsh-out.log:2');
  });

  it('优先看修改时间最新的文件(旧进程的 token 已失效)', async () => {
    const dir = makeLogDir(
      { 'dsh-out.log': line('OLD_token1'), 'dsh-out-1.log': line('NEW_token2') },
      { 'dsh-out.log': 1_000_000, 'dsh-out-1.log': 2_000_000 },
    );
    expect((await findLatestToken(dir, 'dsh-out'))?.token).toBe('NEW_token2');
  });

  it('忽略不相关文件;没有 token 时返回 null', async () => {
    const dir = makeLogDir({ 'dsh-out.log': 'no token here\n', 'other.log': line('IGNORED_x') });
    expect(await findLatestToken(dir, 'dsh-out')).toBeNull();
    expect(await findLatestToken(join(dir, 'nope'), 'dsh-out')).toBeNull();
  });

  it('日志目录不存在时返回 null(不抛异常)', async () => {
    expect(await findLatestToken('/nonexistent-pm2-dir', 'dsh-out')).toBeNull();
  });
});

describe('dshRoute', () => {
  const fakeCtx = (): ApiContext =>
    ({
      req: {} as IncomingMessage,
      res: {} as ApiContext['res'],
      url: new URL('http://localhost/api/dsh/login-url'),
      query: new URLSearchParams(),
      body: undefined,
      ip: '127.0.0.1',
      log: silent,
    }) as ApiContext;

  const deps = (overrides: Partial<Parameters<typeof dshRoute>[0]> = {}) => ({
    logDir: makeLogDir({ 'dsh-out.log': 'dsh web: http://127.0.0.1:3080/?token=TOKEN_abcdef12\n' }),
    logPrefix: 'dsh-out',
    publicHost: 'dsh.example.com',
    port: 3080,
    validate: async () => 303,
    ...overrides,
  });

  it('返回可直接打开的地址,且只暴露 token 前 8 位', async () => {
    const payload = (await dshRoute(deps()).handle(fakeCtx())) as {
      url: string;
      tokenPreview: string;
      valid: boolean;
      source: string;
      host: string;
    };
    expect(payload.url).toBe('https://dsh.example.com/?token=TOKEN_abcdef12');
    expect(payload.tokenPreview).toBe('TOKEN_ab');
    expect(payload.valid).toBe(true);
    expect(payload.source).toBe('dsh-out.log:1');
  });

  it('校验不是 303 时标记 valid:false(dsh 重启过)', async () => {
    const payload = (await dshRoute(deps({ validate: async () => 401 })).handle(fakeCtx())) as {
      valid: boolean;
    };
    expect(payload.valid).toBe(false);
  });

  it('没有可用 token 时抛 503', async () => {
    const route = dshRoute(deps({ logDir: makeLogDir({}) }));
    await expect(route.handle(fakeCtx())).rejects.toMatchObject({ status: 503, code: 'token_not_found' });
  });

  it('校验请求异常时抛 502', async () => {
    const route = dshRoute(
      deps({
        validate: async () => {
          throw new Error('boom');
        },
      }),
    );
    await expect(route.handle(fakeCtx())).rejects.toMatchObject({ status: 502, code: 'validate_failed' });
  });
});

describe('鉴权接口的 HTTP 集成', () => {
  const dshDeps = () => ({
    logDir: makeLogDir({ 'dsh-out.log': 'dsh web: http://127.0.0.1:3080/?token=TOKEN_abcdef12\n' }),
    logPrefix: 'dsh-out',
    publicHost: 'dsh.example.com',
    port: 3080,
    validate: async () => 303,
  });

  it('不带密钥 401,且响应体不含任何 token 片段', async () => {
    await withApp({ dsh: dshDeps() }, async (base) => {
      const res = await fetch(`${base}/api/dsh/login-url`);
      expect(res.status).toBe(401);
      const text = await res.text();
      expect(text).not.toContain('TOKEN_');
      expect(JSON.parse(text)).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    });
  });

  it('密钥错误 401;密钥正确 200 且返回地址', async () => {
    await withApp({ dsh: dshDeps() }, async (base) => {
      expect((await fetch(`${base}/api/dsh/login-url`, { headers: { 'X-Api-Key': '000000' } })).status).toBe(401);
      const res = await fetch(`${base}/api/dsh/login-url`, { headers: { 'X-Api-Key': KEY } });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const payload = (await res.json()) as { ok: boolean; data: { url: string; valid: boolean } };
      expect(payload.ok).toBe(true);
      expect(payload.data.url).toContain('token=TOKEN_abcdef12');
      expect(payload.data.valid).toBe(true);
    });
  });

  it('未配置密钥时返回 503(fail-closed,绝不放行)', async () => {
    await withApp({ apiKey: '', dsh: dshDeps() }, async (base) => {
      const res = await fetch(`${base}/api/dsh/login-url`, { headers: { 'X-Api-Key': KEY } });
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(text).not.toContain('TOKEN_');
      expect(JSON.parse(text)).toMatchObject({ error: { code: 'api_key_not_configured' } });
    });
  });

  it('连续错误密钥触发全局冷却(429 auth_locked)', async () => {
    await withApp({ dsh: dshDeps(), authFailureBudget: 3, authRateLimit: 100 }, async (base) => {
      for (let i = 0; i < 3; i += 1) {
        const res = await fetch(`${base}/api/dsh/login-url`, { headers: { 'X-Api-Key': 'wrong' } });
        expect(res.status).toBe(401);
        await res.arrayBuffer();
      }
      const locked = await fetch(`${base}/api/dsh/login-url`, { headers: { 'X-Api-Key': KEY } });
      expect(locked.status).toBe(429);
      expect(locked.headers.get('retry-after')).toBeTruthy();
      const payload = (await locked.json()) as { error: { code: string } };
      expect(payload.error.code).toBe('auth_locked');
    });
  });

  it('鉴权接口有独立的更严格限流', async () => {
    await withApp({ dsh: dshDeps(), authRateLimit: 2, authFailureBudget: 100 }, async (base) => {
      const codes: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const res = await fetch(`${base}/api/dsh/login-url`, { headers: { 'X-Api-Key': KEY } });
        codes.push(res.status);
        await res.arrayBuffer();
      }
      expect(codes).toEqual([200, 200, 429]);
    });
  });
});
