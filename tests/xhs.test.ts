/**
 * 小红书卡片接口(POST /api/xhs/cards、GET /api/xhs/card)与 ZIP 打包的测试。
 *
 * 关注点:
 *   1. 鉴权:没有密钥时**绝不能执行命令**(执行器一次都不能被调用)
 *   2. 参数:日期格式错就地拒绝,不执行;合法日期以 `--date=值` 传给 Python
 *   3. 失败映射:命令非 0 → 502,超时 → 504,输出不是 JSON → 502
 *   4. 冷却:成功后短时间内再点 → 429 且带 Retry-After
 *   5. 图片读取:只允许 `YYYY-MM-DD` + `card-NN.png`,路径穿越一律 400
 *   6. ZIP:store 模式结构与 CRC 正确(用标准测试向量校验)
 *   7. 日期默认值:按**本地**时区取年月日(不是 UTC)
 *
 * 全部注入桩执行器,测试永远不会真的去跑 python。
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../server/app.ts';
import { createLogger } from '../server/log.ts';
import type { NewsDeps } from '../server/routes/news.ts';
import type { XhsExecResult } from '../server/routes/xhs.ts';
import { localDateString } from '../tools/xhs-cards/date.ts';
import { buildZip, crc32 } from '../tools/xhs-cards/zip.ts';

const silent = createLogger('error', () => undefined);
const KEY = '521016';
const DATE = '2026-11-03';

/** 一张卡片 PNG 的假字节(不需要真是 PNG,接口只负责原样转发) */
const FAKE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);

function makeDist(): string {
  const dist = mkdtempSync(join(tmpdir(), 'agg-dist-'));
  writeFileSync(join(dist, 'index.html'), '<!DOCTYPE html><html><body>home</body></html>');
  writeFileSync(join(dist, 'tools.json'), JSON.stringify({ count: 1, tools: [] }));
  return dist;
}

/** 造一个带图片的 ai-news-daily 输出目录 */
function makeProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agg-xhs-'));
  const xhs = join(dir, 'output', DATE, 'xhs');
  mkdirSync(xhs, { recursive: true });
  writeFileSync(join(xhs, 'card-01.png'), FAKE_PNG);
  // 目录外的文件,用于验证路径穿越被挡住
  writeFileSync(join(dir, 'secret.txt'), 'TOP-SECRET');
  return dir;
}

function okJson(count = 2): string {
  return JSON.stringify({
    date: DATE,
    out_dir: '/tmp',
    count,
    files: [{ name: 'card-01.png', bytes: 9 }, { name: 'card-02.png', bytes: 9 }],
  });
}

interface Harness {
  base: string;
  calls: string[][];
  close: () => Promise<void>;
}

async function start(options: {
  apiKey?: string;
  cooldownSeconds?: number;
  now?: () => number;
  respond?: (args: string[]) => XhsExecResult;
  projectDir?: string;
} = {}): Promise<Harness> {
  const calls: string[][] = [];
  const run = vi.fn(async (args: string[]): Promise<XhsExecResult> => {
    calls.push(args);
    if (options.respond !== undefined) return options.respond(args);
    return { code: 0, stdout: okJson(), stderr: '' };
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
    // 小红书接口复用的就是 news 的 pythonBin / projectDir / run。
    // 冷却秒数是 xhs 自己的配置(NewsDeps 里没有,也不该有),所以这里显式转型 ——
    // 这样既不用为了测试去改 NewsDeps(那会牵动 4 个 harness),又能测到冷却。
    news: {
      pythonBin: '/definitely/not/here/python3',
      projectDir: options.projectDir ?? makeProjectDir(),
      fetchTimeoutSeconds: 5,
      addCooldownSeconds: 0,
      run,
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.cooldownSeconds !== undefined
        ? { cooldownSeconds: options.cooldownSeconds }
        : {}),
    } as NewsDeps,
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

const generate = (base: string, body: unknown, key?: string): Promise<Response> =>
  fetch(`${base}/api/xhs/cards`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key !== undefined ? { 'X-Api-Key': key } : {}),
    },
    body: JSON.stringify(body),
  });

const card = (base: string, query: string): Promise<Response> =>
  fetch(`${base}/api/xhs/card?${query}`);

describe('ZIP 打包', () => {
  it('crc32 与标准测试向量一致', () => {
    // 业界通用向量:CRC-32("123456789") = 0xCBF43926
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('结构合法:local header / 中央目录 / EOCD 的签名与偏移对得上', () => {
    const enc = new TextEncoder();
    const zip = buildZip([
      { name: 'card-01.png', data: enc.encode('AAA') },
      { name: 'card-02.png', data: enc.encode('BBBBB') },
    ]);
    const view = new DataView(zip.buffer);

    // 第一条 local header 签名
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    // 压缩方法必须是 0(store)
    expect(view.getUint16(8, true)).toBe(0);

    // EOCD 在最后 22 字节
    const eocd = zip.length - 22;
    expect(view.getUint32(eocd, true)).toBe(0x06054b50);
    expect(view.getUint16(eocd + 10, true)).toBe(2);   // 总条目数
    const cdSize = view.getUint32(eocd + 12, true);
    const cdOffset = view.getUint32(eocd + 16, true);
    expect(cdOffset + cdSize).toBe(eocd);              // 中央目录紧接 EOCD 之前
    expect(view.getUint32(cdOffset, true)).toBe(0x02014b50);

    // 中央目录里第一条记录的 local header 偏移应为 0
    expect(view.getUint32(cdOffset + 42, true)).toBe(0);
  });

  it('能正确处理空列表', () => {
    const zip = buildZip([]);
    expect(zip.length).toBe(22);
    const view = new DataView(zip.buffer);
    expect(view.getUint32(0, true)).toBe(0x06054b50);
    expect(view.getUint16(10, true)).toBe(0);
  });
});

describe('POST /api/xhs/cards', () => {
  it('没有密钥 → 401,且不执行命令', async () => {
    const h = await start();
    try {
      const res = await generate(h.base, {});
      expect(res.status).toBe(401);
      expect(h.calls).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('密钥错误 → 401,且不执行命令', async () => {
    const h = await start();
    try {
      const res = await generate(h.base, {}, 'wrong-key');
      expect(res.status).toBe(401);
      expect(h.calls).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('日期格式不对 → 400,且不执行命令', async () => {
    const h = await start();
    try {
      const res = await generate(h.base, { date: '2026/11/03' }, KEY);
      expect(res.status).toBe(400);
      const payload = (await res.json()) as { error: { code: string } };
      expect(payload.error.code).toBe('invalid_date');
      expect(h.calls).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('不传日期 → 不带任何参数(由 CLI 自己取最新一天)', async () => {
    const h = await start();
    try {
      const res = await generate(h.base, {}, KEY);
      expect(res.status).toBe(200);
      expect(h.calls).toEqual([[]]);
      const payload = (await res.json()) as { data: { count: number; date: string } };
      expect(payload.data.date).toBe(DATE);
      expect(payload.data.count).toBe(2);
    } finally {
      await h.close();
    }
  });

  it('传日期 → 以 --date=值 形式传递(不会被当成新选项)', async () => {
    const h = await start();
    try {
      await generate(h.base, { date: DATE }, KEY);
      expect(h.calls).toEqual([[`--date=${DATE}`]]);
    } finally {
      await h.close();
    }
  });

  it('命令失败 → 502', async () => {
    const h = await start({ respond: () => ({ code: 1, stdout: '', stderr: 'boom' }) });
    try {
      const res = await generate(h.base, {}, KEY);
      expect(res.status).toBe(502);
    } finally {
      await h.close();
    }
  });

  it('超时被杀 → 504', async () => {
    const h = await start({ respond: () => ({ code: -1, stdout: '', stderr: '', killed: true }) });
    try {
      const res = await generate(h.base, {}, KEY);
      expect(res.status).toBe(504);
    } finally {
      await h.close();
    }
  });

  it('输出不是 JSON → 502', async () => {
    const h = await start({ respond: () => ({ code: 0, stdout: 'not json', stderr: '' }) });
    try {
      const res = await generate(h.base, {}, KEY);
      expect(res.status).toBe(502);
    } finally {
      await h.close();
    }
  });

  it('输出缺少字段 → 502', async () => {
    const h = await start({ respond: () => ({ code: 0, stdout: JSON.stringify({ hello: 1 }), stderr: '' }) });
    try {
      const res = await generate(h.base, {}, KEY);
      expect(res.status).toBe(502);
    } finally {
      await h.close();
    }
  });

  it('冷却期内重复点击 → 429 且带 Retry-After', async () => {
    let clock = 1_000_000;
    const h = await start({ cooldownSeconds: 10, now: () => clock });
    try {
      expect((await generate(h.base, {}, KEY)).status).toBe(200);
      clock += 3_000; // 只过了 3 秒
      const second = await generate(h.base, {}, KEY);
      expect(second.status).toBe(429);
      expect(second.headers.get('Retry-After')).toBe('7');

      clock += 8_000; // 累计 11 秒,冷却已过
      expect((await generate(h.base, {}, KEY)).status).toBe(200);
    } finally {
      await h.close();
    }
  });
});

describe('GET /api/xhs/card', () => {
  it('正常取图 → 200 + image/png + 字节一致', async () => {
    const h = await start();
    try {
      const res = await card(h.base, `date=${DATE}&name=card-01.png`);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('image/png');
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect([...bytes]).toEqual([...FAKE_PNG]);
    } finally {
      await h.close();
    }
  });

  it('日期或文件名非法 → 400', async () => {
    const h = await start();
    try {
      expect((await card(h.base, 'date=../../etc&name=card-01.png')).status).toBe(400);
      expect((await card(h.base, `date=${DATE}&name=evil.png`)).status).toBe(400);
      expect((await card(h.base, `date=${DATE}&name=card-01.png.bak`)).status).toBe(400);
      expect((await card(h.base, 'name=card-01.png')).status).toBe(400);
    } finally {
      await h.close();
    }
  });

  it('文件名试图穿越 → 400,读不到目录外的文件', async () => {
    const h = await start();
    try {
      const res = await card(h.base, `date=${DATE}&name=../secret.txt`);
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain('TOP-SECRET');
    } finally {
      await h.close();
    }
  });

  it('文件不存在 → 404', async () => {
    const h = await start();
    try {
      expect((await card(h.base, `date=${DATE}&name=card-99.png`)).status).toBe(404);
    } finally {
      await h.close();
    }
  });
});

describe('日期默认值(本地时区)', () => {
  it('按本地年月日拼 YYYY-MM-DD', () => {
    expect(localDateString(new Date(2026, 0, 5, 0, 30))).toBe('2026-01-05');
  });

  it('不能用 UTC —— 东八区凌晨时 UTC 还在前一天', () => {
    const midnight = new Date(2026, 0, 5, 0, 30);
    // 只有当机器不在 UTC 时才有区别;断言本地结果仍是 5 号即可
    expect(localDateString(midnight)).toBe('2026-01-05');
    if (midnight.getTimezoneOffset() !== 0) {
      expect(midnight.toISOString().slice(0, 10)).not.toBe('2026-01-05');
    }
  });

  it('月/日补零', () => {
    expect(localDateString(new Date(2026, 8, 3))).toBe('2026-09-03');
  });

  it('跨年边界', () => {
    expect(localDateString(new Date(2025, 11, 31, 23, 59))).toBe('2025-12-31');
  });
});
