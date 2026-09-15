/**
 * 手工新闻接口(GET/POST /api/news/manual)的服务端测试。
 *
 * 这个接口横跨两个项目:工具站(Node)用 execFile 调 ai-news-daily 的 Python CLI,
 * 读回 JSON。测试重点因此是**边界**而不是"能不能加新闻":
 *
 *   1. 鉴权:没密钥 / 密钥错 → 401,且**绝不能执行命令**(执行器一次都不能被调用)
 *   2. 不做 shell:参数以数组传入,用户给的值**只能**作为值出现 ——
 *      尤其不能让 `--title=--list` 这种值被当成分离的选项(参数注入防护)
 *   3. 输入校验:非 http(s) 链接、超长字段直接被拒,且不会去执行命令
 *   4. 冷却:只对"成功添加"生效;重复/非法不占用冷却
 *   5. 失败处理:python 缺失 → 503;输出不是 JSON → 502;超时 → 504
 *
 * 所有用例都注入桩执行器,测试永远不会真的去跑 python。
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../server/app.ts';
import { createLogger } from '../server/log.ts';
import type { NewsExecResult } from '../server/routes/news.ts';

const silent = createLogger('error', () => undefined);
const KEY = '521016';

function makeDist(): string {
  const dist = mkdtempSync(join(tmpdir(), 'agg-dist-'));
  writeFileSync(join(dist, 'index.html'), '<!DOCTYPE html><html><body>home</body></html>');
  writeFileSync(join(dist, 'tools.json'), JSON.stringify({ count: 1, tools: [] }));
  return dist;
}

/** 造一份"Python 返回的列表"JSON */
function listJson(entries: Array<Record<string, unknown>> = []): string {
  return JSON.stringify({
    ok: true,
    action: 'list',
    today: '2026-09-16',
    queue_file: '/tmp/manual_queue.json',
    entries,
  });
}

const ENTRY = {
  id: 'abc123',
  url: 'https://example.com/news/1',
  title: '一条手工新闻',
  summary: '',
  note: '',
  added_at: '2026-09-16T10:00:00',
  consumed_at: '',
  result: '',
  status: '待用',
  body_chars: 1200,
  is_today: true,
};

interface Harness {
  base: string;
  /** 每次调用收到的 argv(用于断言"传了什么参数") */
  calls: string[][];
  close: () => Promise<void>;
}

async function start(options: {
  apiKey?: string;
  cooldownSeconds?: number;
  now?: () => number;
  respond?: (args: string[]) => NewsExecResult;
  /** 不注入执行器(用于测试 python 不存在等真实路径分支) */
  realRunner?: boolean;
} = {}): Promise<Harness> {
  const calls: string[][] = [];
  const run = vi.fn(async (args: string[]): Promise<NewsExecResult> => {
    calls.push(args);
    if (options.respond !== undefined) return options.respond(args);
    return { code: 0, stdout: listJson([ENTRY]), stderr: '' };
  });

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
      pm2Bin: '/nonexistent/pm2',
      appName: 'dsh',
      pm2Home: '/tmp',
      cooldownSeconds: 0,
      run: async () => ({ ok: true, detail: 'stub' }),
    },
    news: {
      pythonBin: '/definitely/not/here/python3',
      projectDir: '/tmp',
      fetchTimeoutSeconds: 5,
      addCooldownSeconds: options.cooldownSeconds ?? 0,
      ...(options.realRunner === true ? {} : { run }),
      ...(options.now !== undefined ? { now: options.now } : {}),
    },
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

const get = (base: string, key?: string): Promise<Response> =>
  fetch(`${base}/api/news/manual`, {
    headers: key !== undefined ? { 'X-Api-Key': key } : {},
  });

const post = (base: string, body: unknown, key?: string): Promise<Response> =>
  fetch(`${base}/api/news/manual`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key !== undefined ? { 'X-Api-Key': key } : {}),
    },
    body: JSON.stringify(body),
  });

describe('手工新闻接口 —— 鉴权', () => {
  it('没有密钥 → 401,且不执行命令', async () => {
    const app = await start();
    try {
      const res = await get(app.base);
      expect(res.status).toBe(401);
      expect(app.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('密钥错误 → 401,且不执行命令', async () => {
    const app = await start();
    try {
      expect((await get(app.base, 'wrong')).status).toBe(401);
      expect((await post(app.base, { url: 'https://example.com/a' }, 'wrong')).status).toBe(401);
      expect(app.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('服务端未配置密钥 → 503(fail-closed,不放行)', async () => {
    const app = await start({ apiKey: '' });
    try {
      const res = await get(app.base, KEY);
      expect(res.status).toBe(503);
      const payload = (await res.json()) as { error: { code: string } };
      expect(payload.error.code).toBe('api_key_not_configured');
      expect(app.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});

describe('手工新闻接口 —— 列表', () => {
  it('带正确密钥 → 返回列表,并把蛇形字段转成驼峰', async () => {
    const app = await start();
    try {
      const res = await get(app.base, KEY);
      expect(res.status).toBe(200);
      const payload = (await res.json()) as {
        ok: boolean;
        data: {
          today: string;
          queueFile: string;
          entries: Array<Record<string, unknown>>;
          counts: { today: number; pending: number; duplicate: number };
        };
      };
      expect(payload.ok).toBe(true);
      expect(payload.data.today).toBe('2026-09-16');
      expect(payload.data.queueFile).toBe('/tmp/manual_queue.json');
      expect(payload.data.entries).toHaveLength(1);
      const entry = payload.data.entries[0]!;
      expect(entry['addedAt']).toBe('2026-09-16T10:00:00');
      expect(entry['bodyChars']).toBe(1200);
      expect(entry['isToday']).toBe(true);
      // 不应把 Python 侧的中文状态原样透传(前端自行从 result/consumedAt 推断)
      expect(entry['status']).toBeUndefined();
      expect(payload.data.counts).toEqual({ today: 1, pending: 1, duplicate: 0 });
      // 调用参数固定为 --list
      expect(app.calls[0]).toEqual(['--list']);
    } finally {
      await app.close();
    }
  });

  it('统计:重复跳过的不计入待用', async () => {
    const app = await start({
      respond: () => ({
        code: 0,
        stderr: '',
        stdout: listJson([
          ENTRY,
          { ...ENTRY, id: 'dup1', result: 'duplicate', consumed_at: '2026-09-16T06:00:00' },
          { ...ENTRY, id: 'used1', result: 'included', consumed_at: '2026-09-16T06:00:00' },
        ]),
      }),
    });
    try {
      const res = await get(app.base, KEY);
      const payload = (await res.json()) as { data: { counts: Record<string, number> } };
      expect(payload.data.counts).toEqual({ today: 3, pending: 1, duplicate: 1 });
    } finally {
      await app.close();
    }
  });
});

describe('手工新闻接口 —— 添加', () => {
  it('成功添加 → action=added,并把刷新后的列表一起带回', async () => {
    const app = await start({
      respond: () => ({
        code: 0,
        stderr: '',
        stdout: JSON.stringify({
          ok: true,
          action: 'add',
          today: '2026-09-16',
          queue_file: '/tmp/manual_queue.json',
          results: [{ url: ENTRY.url, action: 'added', id: 'abc123', title: '一条手工新闻', body_chars: 1200, message: '' }],
          entries: [ENTRY],
        }),
      }),
    });
    try {
      const res = await post(app.base, { url: ENTRY.url }, KEY);
      expect(res.status).toBe(200);
      const payload = (await res.json()) as {
        data: { action: string; entry: Record<string, unknown> | null; list: { entries: unknown[] } };
      };
      expect(payload.data.action).toBe('added');
      expect(payload.data.entry?.['id']).toBe('abc123');
      // 列表随响应返回 → 前端添加完不必再发一次 GET(省一个限流额度)
      expect(payload.data.list.entries).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('重复链接 → action=duplicate,不产生 entry', async () => {
    const app = await start({
      respond: () => ({
        code: 0,
        stderr: '',
        stdout: JSON.stringify({
          ok: true,
          action: 'add',
          today: '2026-09-16',
          results: [{ url: ENTRY.url, action: 'duplicate', id: '', title: '', body_chars: 0, message: '最近日报已收录过' }],
          entries: [ENTRY],
        }),
      }),
    });
    try {
      const res = await post(app.base, { url: ENTRY.url }, KEY);
      const payload = (await res.json()) as { data: { action: string; entry: unknown; message: string } };
      expect(payload.data.action).toBe('duplicate');
      expect(payload.data.entry).toBeNull();
      expect(payload.data.message).toBe('最近日报已收录过');
    } finally {
      await app.close();
    }
  });

  it('参数以数组传递,URL 放在最后;用户输入不会被当成选项', async () => {
    const app = await start();
    try {
      await post(app.base, { url: 'https://example.com/a', title: 'T', summary: 'S', note: 'N' }, KEY);
      const args = app.calls[0]!;
      expect(args.slice(0, 4)).toEqual(['--timeout', '5', '--title=T', '--summary=S']);
      expect(args[4]).toBe('--note=N');
      expect(args[5]).toBe('https://example.com/a');
    } finally {
      await app.close();
    }
  });

  it('标题里塞 `--list` 只会作为值出现,不会变成独立选项(参数注入防护)', async () => {
    const app = await start();
    try {
      await post(app.base, { url: 'https://example.com/a', title: '--list' }, KEY);
      const args = app.calls[0]!;
      expect(args).toContain('--title=--list');
      // 关键:不存在独立的 '--list' 选项,否则 Python 会当成"列出队列"而不添加
      expect(args).not.toContain('--list');
    } finally {
      await app.close();
    }
  });

  it('非 http(s) 链接 → 400,且不执行命令', async () => {
    const app = await start();
    try {
      for (const bad of ['file:///etc/passwd', 'ftp://example.com', 'javascript:alert(1)', '   ']) {
        const res = await post(app.base, { url: bad }, KEY);
        expect(res.status).toBe(400);
        const payload = (await res.json()) as { error: { code: string } };
        expect(payload.error.code).toBe('invalid_url');
      }
      expect(app.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('字段超长 / 非字符串 → 400,且不执行命令', async () => {
    const app = await start();
    try {
      const long = 'x'.repeat(2001);
      expect((await post(app.base, { url: `https://e.com/${long}` }, KEY)).status).toBe(400);
      expect((await post(app.base, { url: 'https://e.com/a', title: 'x'.repeat(301) }, KEY)).status).toBe(400);
      expect((await post(app.base, { url: 'https://e.com/a', note: 123 }, KEY)).status).toBe(400);
      expect(app.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('请求体不是对象 → 400', async () => {
    const app = await start();
    try {
      expect((await post(app.base, ['https://e.com/a'], KEY)).status).toBe(400);
      expect(app.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});

describe('手工新闻接口 —— 冷却', () => {
  it('成功添加后立即再添加 → 429 add_cooldown(带 Retry-After)', async () => {
    const app = await start({
      cooldownSeconds: 30,
      respond: () => ({
        code: 0,
        stderr: '',
        stdout: JSON.stringify({
          ok: true, action: 'add', today: '2026-09-16',
          results: [{ url: 'https://e.com/a', action: 'added', id: 'x', title: 't', body_chars: 1, message: '' }],
          entries: [ENTRY],
        }),
      }),
    });
    try {
      expect((await post(app.base, { url: 'https://e.com/a' }, KEY)).status).toBe(200);
      const res = await post(app.base, { url: 'https://e.com/b' }, KEY);
      expect(res.status).toBe(429);
      const payload = (await res.json()) as { error: { code: string } };
      expect(payload.error.code).toBe('add_cooldown');
      expect(res.headers.get('retry-after')).toBeTruthy();
      // 第二次请求根本没走到执行器
      expect(app.calls).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('冷却过后可以再次添加', async () => {
    let clock = 1_000_000;
    const app = await start({
      cooldownSeconds: 30,
      now: () => clock,
      respond: () => ({
        code: 0,
        stderr: '',
        stdout: JSON.stringify({
          ok: true, action: 'add', today: '2026-09-16',
          results: [{ url: 'https://e.com/a', action: 'added', id: 'x', title: 't', body_chars: 1, message: '' }],
          entries: [ENTRY],
        }),
      }),
    });
    try {
      expect((await post(app.base, { url: 'https://e.com/a' }, KEY)).status).toBe(200);
      clock += 31_000;
      expect((await post(app.base, { url: 'https://e.com/b' }, KEY)).status).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('重复链接不占用冷却(用户可以继续添加别的)', async () => {
    const app = await start({
      cooldownSeconds: 30,
      respond: () => ({
        code: 0,
        stderr: '',
        stdout: JSON.stringify({
          ok: true, action: 'add', today: '2026-09-16',
          results: [{ url: 'https://e.com/a', action: 'duplicate', id: '', title: '', body_chars: 0, message: 'dup' }],
          entries: [ENTRY],
        }),
      }),
    });
    try {
      expect((await post(app.base, { url: 'https://e.com/a' }, KEY)).status).toBe(200);
      expect((await post(app.base, { url: 'https://e.com/b' }, KEY)).status).toBe(200);
      expect(app.calls).toHaveLength(2);
    } finally {
      await app.close();
    }
  });
});

describe('手工新闻接口 —— 失败处理', () => {
  it('python 不存在(未注入执行器)→ 503 python_not_found', async () => {
    const app = await start({ realRunner: true });
    try {
      const res = await get(app.base, KEY);
      expect(res.status).toBe(503);
      const payload = (await res.json()) as { error: { code: string } };
      expect(payload.error.code).toBe('python_not_found');
    } finally {
      await app.close();
    }
  });

  it('输出不是 JSON → 502,且不回传内部细节', async () => {
    const app = await start({
      respond: () => ({ code: 1, stdout: 'Traceback (most recent call last): secret-path', stderr: 'boom' }),
    });
    try {
      const res = await get(app.base, KEY);
      expect(res.status).toBe(502);
      const payload = (await res.json()) as { error: { code: string; message: string } };
      expect(payload.error.code).toBe('news_command_failed');
      expect(payload.error.message).not.toContain('secret-path');
      expect(payload.error.message).not.toContain('Traceback');
    } finally {
      await app.close();
    }
  });

  it('执行被超时杀掉 → 504', async () => {
    const app = await start({
      respond: () => ({ code: 1, stdout: '', stderr: '', killed: true }),
    });
    try {
      const res = await post(app.base, { url: 'https://e.com/slow' }, KEY);
      expect(res.status).toBe(504);
      const payload = (await res.json()) as { error: { code: string } };
      expect(payload.error.code).toBe('timeout');
    } finally {
      await app.close();
    }
  });
});
