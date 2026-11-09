// @vitest-environment happy-dom
/**
 * 「小红书卡片」工具的界面行为测试。
 *
 * 卡片已经并进日报流程(cron 每天 07:00 生成),所以工具页的语义变了:
 * **默认是浏览和下载,不需要密钥**;只有"强制重新生成"才要密钥。
 *
 * 关注点:
 *   1. 打开页面自动读取日期列表,并默认选最新一天
 *   2. 选日期只发**只读**请求(GET),**不带** X-Api-Key
 *   3. 渲染全部缩略图,并**立刻预取**(iOS 要求 share 在用户手势里同步调用)
 *   4. 那一天没卡片时,给出"还没生成 / 已清理"的提示
 *   5. 重新生成:没密钥 → 不发请求;有密钥 → POST 带 force 与请求头,并把密钥清空
 *   6. 有系统分享 → 调用一次带全部文件;没有 → 退回逐张下载
 *
 * 全程 mock fetch,不会真的碰后端。
 */

import { readFileSync } from 'node:fs';

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { DOWNLOAD_GAP_MS } from '../tools/xhs-cards/constants';

const KEY = '521016';
const DATE = '2026-11-09';
const OTHER = '2026-11-08';
const CARD_COUNT = 3;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]);

interface Called {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

let calls: Called[] = [];
/** 下一次「读某天卡片」的响应,默认成功;测试可改成 404 */
let cardsResponse: () => Response;

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function cardsData(date: string): Record<string, unknown> {
  return {
    date,
    count: CARD_COUNT,
    files: Array.from({ length: CARD_COUNT }, (_, i) => ({
      name: `card-0${i + 1}.png`,
      bytes: PNG.length,
    })),
  };
}

function mockFetch(url: string): Response {
  if (url.includes('/api/xhs/dates')) {
    return json(200, {
      ok: true,
      data: { dates: [{ date: DATE, count: CARD_COUNT }, { date: OTHER, count: 2 }] },
    });
  }
  if (url.includes('/api/xhs/cards?')) {
    return cardsResponse();
  }
  if (url.includes('/api/xhs/cards')) {
    // POST 重新生成
    return json(200, { ok: true, data: { ...cardsData(DATE), reused: false } });
  }
  if (url.includes('/api/xhs/card?')) {
    return new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } });
  }
  return json(404, { ok: false, error: { code: 'not_found', message: 'x' } });
}

function bodyHtml(html: string): string {
  const match = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  return (match?.[1] ?? '').replace(/<script[\s\S]*?<\/script>/gi, '');
}

const q = <T extends Element>(sel: string): T => document.querySelector<T>(sel)!;
const statusText = (): string => q('#status').textContent ?? '';
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
/** 等预取跑完(它要发 CARD_COUNT 次请求) */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await flush();
};

beforeAll(async () => {
  document.body.innerHTML = bodyHtml(readFileSync('tools/xhs-cards/index.html', 'utf8'));
  // ⚠️ 必须在 import main.ts 之前就把 fetch 换掉:模块顶层会立刻 loadDates()
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    const call: Called = {
      url: String(url),
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>)
          .map(([k, v]) => [k.toLowerCase(), v])),
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    return mockFetch(call.url);
  }));
  await import('../tools/xhs-cards/main.ts');
  await settle();
});

beforeEach(async () => {
  calls = [];
  cardsResponse = () => json(200, { ok: true, data: cardsData(DATE) });
  q<HTMLInputElement>('#key').value = '';
  q('#grid').replaceChildren();
  q('#status').textContent = '';
  q('#result').setAttribute('hidden', '');
  // 重新读一次日期列表,让每轮从干净状态开始
  q<HTMLButtonElement>('#reload').click();
  await settle();
});

describe('小红书卡片工具', () => {
  it('打开页面就自动填好日期下拉框,默认选最新一天', async () => {
    const options = [...q<HTMLSelectElement>('#date').options].map((o) => o.value);
    expect(options).toEqual([DATE, OTHER]);
    expect(q<HTMLSelectElement>('#date').value).toBe(DATE);
  });

  it('选日期只发只读请求,且不带密钥', async () => {
    const load = calls.find((c) => c.url.includes('/api/xhs/cards?'));
    expect(load?.method).toBe('GET');
    expect(load?.headers['x-api-key']).toBeUndefined();
    expect(q('#grid').querySelectorAll('img')).toHaveLength(CARD_COUNT);
  });

  it('渲染全部缩略图并预取,预取完成后下载按钮可用', async () => {
    const cardCalls = calls.filter((c) => c.url.includes('/api/xhs/card?'));
    expect(cardCalls).toHaveLength(CARD_COUNT);
    expect(q<HTMLButtonElement>('#save').disabled).toBe(false);
    expect(q<HTMLButtonElement>('#zip').disabled).toBe(false);
  });

  it('那一天没有卡片时,提示「还没生成 / 已清理」', async () => {
    cardsResponse = () => json(404, {
      ok: false,
      error: { code: 'card_not_found', message: '没有' },
    });
    q<HTMLButtonElement>('#reload').click();
    await settle();
    expect(statusText()).toContain('没有卡片');
    expect(q<HTMLElement>('#result').hidden).toBe(true);
  });

  it('重新生成:没输密钥就不发请求', async () => {
    calls = [];
    q<HTMLButtonElement>('#regen').click();
    await flush();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(statusText()).toContain('密钥');
  });

  it('重新生成:POST 带 force 与密钥,完成后清空密钥', async () => {
    q<HTMLInputElement>('#key').value = KEY;
    calls = [];
    q<HTMLButtonElement>('#regen').click();
    await settle();
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.headers['x-api-key']).toBe(KEY);
    expect(post?.url).not.toContain(KEY);
    expect(post?.body).toContain('"force":true');
    expect(q<HTMLInputElement>('#key').value).toBe('');
    expect(window.localStorage.length).toBe(0);
  });

  it('有系统分享 → 调用一次 share,带上全部文件', async () => {
    const share = vi.fn(async (_data: ShareData) => undefined);
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });

    q<HTMLButtonElement>('#save').click();
    await settle();
    expect(share).toHaveBeenCalledTimes(1);
    const payload = share.mock.calls[0]?.[0];
    if (payload === undefined) throw new Error('share 没有被调用');
    expect(payload.files).toHaveLength(CARD_COUNT);
    expect(statusText()).toContain('存储图像');
  });

  it('没有系统分享 → 不报错,退回逐张下载', async () => {
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true });

    vi.useFakeTimers();
    try {
      q<HTMLButtonElement>('#save').click();
      for (let i = 0; i < CARD_COUNT; i += 1) {
        await vi.advanceTimersByTimeAsync(DOWNLOAD_GAP_MS);
      }
      expect(statusText()).toContain('逐张');
    } finally {
      vi.useRealTimers();
    }
  });
});
