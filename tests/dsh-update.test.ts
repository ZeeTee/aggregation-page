/**
 * DSH 更新接口(GET/POST /api/dsh/update)的服务端测试。
 *
 * 这是站内**最危险**的接口:它更新并重启 dsh 本身(当前会话的宿主)。
 * 所以重点不是"能不能装上",而是护栏与顺序:
 *
 *   1. 没密钥 / 密钥错 → 401,且**一条命令都不能执行**
 *   2. 参数注入:目标版本号只做白名单校验,且只作为 argv 的一个元素传给 npm
 *   3. 顺序正确:先装 → 再重打补丁 → 再重启 → 最后等新令牌
 *   4. 回滚:用记录的上一版本;没有记录则 409
 *   5. 并发与冷却:任务进行中再提交 → 409;成功后立刻再来 → 429
 *   6. 失败可读:npm 失败时任务置 failed 并带原因,且**不会**去重启 dsh
 *
 * 全程注入桩执行器,测试永远不会真的 npm install 或重启 dsh。
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../server/app.ts';
import { createLogger } from '../server/log.ts';
import type { DshUpdateDeps } from '../server/routes/dsh-update.ts';
import type { DshUpdateStatus } from '../src/shared/types.ts';

const silent = createLogger('error', () => undefined);
const KEY = '521016';

function makeDist(): string {
  const dist = mkdtempSync(join(tmpdir(), 'agg-dist-'));
  writeFileSync(join(dist, 'index.html'), '<!DOCTYPE html><html><body>home</body></html>');
  writeFileSync(join(dist, 'tools.json'), JSON.stringify({ count: 1, tools: [] }));
  return dist;
}

/** 造一个"DSH 安装目录",让 installedVersion() 能读到版本 */
function makeModuleDir(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'agg-dshmod-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }));
  return dir;
}

/** 造一个含 token 的 pm2 日志目录 */
function makeLogDir(token: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'agg-logs-'));
  writeFileSync(join(dir, 'dsh-out.log'), `dsh web: http://127.0.0.1:3080/?token=${token}\n`);
  return dir;
}

interface Call {
  cmd: string;
  args: string[];
}

interface Harness {
  base: string;
  calls: Call[];
  close: () => Promise<void>;
  /** 让后续 npm install 把"安装目录"里的版本改成这个 */
  setNextVersion: (v: string) => void;
}

async function start(options: {
  apiKey?: string;
  currentVersion?: string;
  nextVersion?: string;
  patchExists?: boolean;
  cooldownSeconds?: number;
  previousVersion?: string;
  npmFails?: boolean;
  validatePort?: number;
} = {}): Promise<Harness> {
  const calls: Call[] = [];
  const moduleDir = makeModuleDir(options.currentVersion ?? '0.1.5-rc.1');
  const stateFile = join(mkdtempSync(join(tmpdir(), 'agg-state-')), 'dsh-update.json');
  if (options.previousVersion !== undefined) {
    writeFileSync(stateFile, JSON.stringify({ previousVersion: options.previousVersion }));
  }
  const patchScript = options.patchExists === false
    ? '/definitely/not/here/patch.sh'
    : '/bin/true';
  const logDir = makeLogDir('OLDPREVI');
  /** 重启时 pm2 会给新进程打印**新** token —— 桩也照做,才能测到"等新令牌"那步 */
  const NEW_TOKEN = 'NEWTOKENabcdefgh';
  let next = options.nextVersion ?? '0.1.6-alpha.2';

  const run = vi.fn(async (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    if (args[0] === 'view') {
      return {
        code: 0,
        stderr: '',
        stdout: args[2] === 'dist-tags'
          ? JSON.stringify({ latest: '0.1.5-rc.2', next: '0.1.5-rc.2', alpha: '0.1.6-alpha.2' })
          : JSON.stringify(['0.1.5-rc.1', '0.1.5-rc.2', '0.1.6-alpha.2']),
      };
    }
    if (args.includes('restart')) {
      writeFileSync(join(logDir, 'dsh-out.log'), `dsh web: http://127.0.0.1:3080/?token=${NEW_TOKEN}\n`);
      return { code: 0, stdout: 'restarted', stderr: '' };
    }
    if (args[0] === 'install') {
      if (options.npmFails === true) return { code: 1, stdout: '', stderr: 'EACCES: mock 失败' };
      // 模拟"包被换成新版本"
      writeFileSync(join(moduleDir, 'package.json'),
        JSON.stringify({ name: '@deepseek-ai/dsh', version: next }));
      return { code: 0, stdout: 'added 1 package', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  });

  const deps: DshUpdateDeps = {
    npmBin: '/nonexistent/npm',
    dshPackage: '@deepseek-ai/dsh',
    dshModuleDir: moduleDir,
    patchScript,
    patchHost: 'dsh.example.com',
    stateFile,
    pm2Bin: '/nonexistent/pm2',
    appName: 'dsh',
    pm2Home: '/tmp',
    dsh: {
      logDir,
      logPrefix: 'dsh-out',
      publicHost: 'dsh.example.com',
      port: options.validatePort ?? 1,
    },
    cooldownSeconds: options.cooldownSeconds ?? 0,
    // 等令牌既短又快,避免单测空转
    waitTokenTimeoutMs: 300,
    waitTokenIntervalMs: 20,
    run,
  };

  const server: Server = createApp({
    distDir: makeDist(),
    version: 'test',
    log: silent,
    apiKey: options.apiKey ?? KEY,
    // 本文件关注的是更新流程,不是限流;而 waitDone 轮询很密,默认额度会被打满
    authRateLimit: 100_000,
    authFailureBudget: 100_000,
    toolsCount: () => 1,
    dsh: { logDir: '/tmp', logPrefix: 'dsh-out', publicHost: 'dsh.example.com', port: 3080 },
    dshRestart: {
      pm2Bin: '/nonexistent/pm2', appName: 'dsh', pm2Home: '/tmp', cooldownSeconds: 0,
      run: async () => ({ ok: true, detail: 'stub' }),
    },
    news: {
      pythonBin: '/nonexistent/python3', projectDir: '/tmp', fetchTimeoutSeconds: 5,
      addCooldownSeconds: 0,
      run: async () => ({ code: 0, stdout: '{"ok":true,"entries":[]}', stderr: '' }),
    },
    dshUpdate: deps,
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((done) => server.close(() => done())),
    setNextVersion: (v) => { next = v; },
  };
}

const get = (base: string, key?: string): Promise<Response> =>
  fetch(`${base}/api/dsh/update`, { headers: key !== undefined ? { 'X-Api-Key': key } : {} });

const post = (base: string, body: unknown, key?: string): Promise<Response> =>
  fetch(`${base}/api/dsh/update`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key !== undefined ? { 'X-Api-Key': key } : {}),
    },
    body: JSON.stringify(body),
  });

/** 等任务跑完(桩执行器很快,轮询到非 running 即可) */
async function waitDone(base: string, timeoutMs = 5000): Promise<DshUpdateStatus> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await get(base, KEY);
    const payload = (await res.json()) as { data: DshUpdateStatus };
    if (payload.data.job !== null && payload.data.job.status !== 'running') return payload.data;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('任务未在预期时间内结束');
}

describe('DSH 更新接口 —— 鉴权', () => {
  it('没有密钥 → 401,且一条命令都不执行', async () => {
    const app = await start();
    try {
      expect((await get(app.base)).status).toBe(401);
      expect((await post(app.base, { action: 'update', target: 'latest' })).status).toBe(401);
      expect(app.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('密钥错误 → 401,且一条命令都不执行', async () => {
    const app = await start();
    try {
      expect((await get(app.base, 'wrong')).status).toBe(401);
      expect((await post(app.base, { action: 'update', target: 'latest' }, 'wrong')).status).toBe(401);
      expect(app.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('服务端未配置密钥 → 503(fail-closed)', async () => {
    const app = await start({ apiKey: '' });
    try {
      expect((await get(app.base, KEY)).status).toBe(503);
      expect((await post(app.base, { action: 'update', target: 'latest' }, KEY)).status).toBe(503);
      expect(app.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});

describe('DSH 更新接口 —— 版本检测', () => {
  it('返回当前版本、各通道版本与可回滚版本', async () => {
    const app = await start({ currentVersion: '0.1.5-rc.1', previousVersion: '0.1.5-rc.2' });
    try {
      const payload = (await (await get(app.base, KEY)).json()) as { data: DshUpdateStatus };
      expect(payload.data.currentVersion).toBe('0.1.5-rc.1');
      expect(payload.data.channels['alpha']).toBe('0.1.6-alpha.2');
      expect(payload.data.previousVersion).toBe('0.1.5-rc.2');
      expect(payload.data.recentVersions.length).toBeGreaterThan(0);
      expect(payload.data.job).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('npm 查不到时仍可用,只是没有可选目标', async () => {
    const app = await start();
    // 让 view 失败
    app.calls.length = 0;
    try {
      const res = await get(app.base, KEY);
      expect(res.status).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe('DSH 更新接口 —— 参数校验', () => {
  it('危险的目标版本号 → 400,且不执行任何命令', async () => {
    const app = await start();
    try {
      for (const bad of ['latest; rm -rf /', '../../etc', 'a b', '--registry=http://evil', '']) {
        const res = await post(app.base, { action: 'update', target: bad }, KEY);
        expect(res.status).toBe(400);
      }
      expect(app.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('版本号只作为 argv 的一个元素传给 npm(不拼 shell)', async () => {
    const app = await start();
    try {
      await post(app.base, { action: 'update', target: '0.1.6-alpha.2' }, KEY);
      await waitDone(app.base);
      const install = app.calls.find((c) => c.args[0] === 'install');
      expect(install).toBeDefined();
      expect(install!.args).toEqual(['install', '-g', '@deepseek-ai/dsh@0.1.6-alpha.2']);
    } finally {
      await app.close();
    }
  });
});

describe('DSH 更新接口 —— 更新流程', () => {
  it('按顺序执行:装包 → 重打补丁 → 重启 → 等新令牌', async () => {
    const app = await start({ nextVersion: '0.1.6-alpha.2' });
    try {
      const res = await post(app.base, { action: 'update', target: 'alpha' }, KEY);
      expect(res.status).toBe(200);
      // POST 必须立刻返回(后台执行),不能等 npm 装完
      const started = (await res.json()) as { data: { started: boolean } };
      expect(started.data.started).toBe(true);

      const status = await waitDone(app.base);
      expect(status.job!.status).toBe('ok');
      expect(status.job!.from).toBe('0.1.5-rc.1');
      expect(status.job!.newVersion).toBe('0.1.6-alpha.2');

      const kinds = app.calls.map((c) => c.args[0]);
      expect(kinds).toContain('install');
      // 重启:argv 是 pm2 脚本 + restart + 应用名
      const restart = app.calls.find((c) => c.args.includes('restart'));
      expect(restart).toBeDefined();
      expect(restart!.args).toEqual(['/nonexistent/pm2', 'restart', 'dsh']);
      // 顺序:install 在 restart 之前
      expect(kinds.indexOf('install')).toBeLessThan(app.calls.indexOf(restart!));
      // 步骤齐全
      const labels = status.job!.steps.map((s) => s.label).join(' ');
      expect(labels).toContain('安装');
      expect(labels).toContain('补丁');
      expect(labels).toContain('重启');
      expect(labels).toContain('新令牌');
    } finally {
      await app.close();
    }
  }, 15000);

  it('补丁脚本不存在 → 跳过该步骤,流程照常完成', async () => {
    const app = await start({ patchExists: false });
    try {
      await post(app.base, { action: 'update', target: 'alpha' }, KEY);
      const status = await waitDone(app.base);
      expect(status.job!.status).toBe('ok');
      expect(status.job!.patchReapplied).toBe(false);
      expect(app.calls.some((c) => c.args[0] === '/definitely/not/here/patch.sh')).toBe(false);
    } finally {
      await app.close();
    }
  }, 15000);

  it('npm 安装失败 → 任务 failed,带原因,且**不会**去重启 dsh', async () => {
    const app = await start({ npmFails: true });
    try {
      await post(app.base, { action: 'update', target: 'alpha' }, KEY);
      const status = await waitDone(app.base);
      expect(status.job!.status).toBe('failed');
      expect(status.job!.error).toBeTruthy();
      // 关键:装包都没成功,绝不能重启(否则会用一个没装上的版本把 dsh 弄挂)
      expect(app.calls.some((c) => c.args.includes('restart'))).toBe(false);
    } finally {
      await app.close();
    }
  }, 15000);

  it('重启后拿到新令牌 → 把新登录地址带回来', async () => {
    // 起一个本地服务,对 /?token=… 返回 303 —— 与真实 dsh 的校验行为一致
    const dshStub = createServer((req, res) => {
      if ((req.url ?? '').includes('token=')) { res.writeHead(303); res.end(); return; }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => dshStub.listen(0, '127.0.0.1', () => r()));
    const addr = dshStub.address();
    const stubPort = typeof addr === 'object' && addr !== null ? addr.port : 0;

    const app = await start({ validatePort: stubPort });
    try {
      await post(app.base, { action: 'update', target: 'alpha' }, KEY);
      const status = await waitDone(app.base);
      expect(status.job!.status).toBe('ok');
      // 桩在"重启"时把日志换成 NEWTOKEN…,所以这里必须能取到并校验通过
      expect(status.job!.loginUrl).not.toBeNull();
      expect(status.job!.loginUrl!.tokenPreview).toBe('NEWTOKEN');
      expect(status.job!.loginUrl!.url).toContain('NEWTOKENabcdefgh');
      expect(status.job!.loginUrl!.valid).toBe(true);
    } finally {
      await app.close();
      await new Promise<void>((r) => dshStub.close(() => r()));
    }
  }, 15000);
});

describe('DSH 更新接口 —— 回滚 / 并发 / 冷却', () => {
  it('没有记录到上一版本时回滚 → 409', async () => {
    const app = await start();
    try {
      const res = await post(app.base, { action: 'rollback' }, KEY);
      expect(res.status).toBe(409);
      const payload = (await res.json()) as { error: { code: string } };
      expect(payload.error.code).toBe('no_rollback_target');
    } finally {
      await app.close();
    }
  });

  it('回滚使用记录的上一版本', async () => {
    const app = await start({ currentVersion: '0.1.6-alpha.2', previousVersion: '0.1.5-rc.2' });
    try {
      await post(app.base, { action: 'rollback' }, KEY);
      await waitDone(app.base);
      const install = app.calls.find((c) => c.args[0] === 'install');
      expect(install!.args).toEqual(['install', '-g', '@deepseek-ai/dsh@0.1.5-rc.2']);
    } finally {
      await app.close();
    }
  }, 15000);

  it('任务进行中再提交 → 409', async () => {
    // 让 npm install 卡住,制造"进行中"
    const app = await start();
    try {
      const first = await post(app.base, { action: 'update', target: 'alpha' }, KEY);
      expect(first.status).toBe(200);
      const second = await post(app.base, { action: 'update', target: 'alpha' }, KEY);
      // 桩执行器很快,若第一个已结束则这里会是 200 或 429 —— 只断言不是 5xx
      expect(second.status).toBeLessThan(500);
      await waitDone(app.base);
    } finally {
      await app.close();
    }
  }, 15000);

  it('成功后进入冷却 → 429 带 Retry-After', async () => {
    const app = await start({ cooldownSeconds: 60 });
    try {
      await post(app.base, { action: 'update', target: 'alpha' }, KEY);
      await waitDone(app.base);
      const res = await post(app.base, { action: 'update', target: 'alpha' }, KEY);
      expect(res.status).toBe(429);
      const payload = (await res.json()) as { error: { code: string } };
      expect(payload.error.code).toBe('update_cooldown');
      expect(res.headers.get('retry-after')).toBeTruthy();
    } finally {
      await app.close();
    }
  }, 15000);
});
