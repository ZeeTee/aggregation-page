// @vitest-environment happy-dom
/**
 * 「小红书卡片」工具的界面行为测试。
 *
 * 服务端契约已由 tests/xhs.test.ts 覆盖,这里只盯**前端自己的逻辑**:
 *   1. 打开页面日期就默认是今天(按本地时区,不是 UTC)
 *   2. 没输密钥就点生成 → **绝不能**发请求
 *   3. 生成成功后渲染出全部缩略图;并且**立刻预取**(iOS 要求 share 在用户手势里
 *      调用,不能等点了按钮再去 fetch)
 *   4. 有系统分享 → 调用一次 share,带上全部文件(手机上「存储图像」的正路)
 *   5. 没有系统分享 → 不报错,退回逐张下载
 *   6. 密钥不持久化:生成后输入框被清空,且不碰 localStorage
 *
 * 全程 mock fetch,不会真的碰后端。
 */

import { readFileSync } from 'node:fs';

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { DOWNLOAD_GAP_MS } from '../tools/xhs-cards/constants';
import { localDateString } from '../tools/xhs-cards/date';

const KEY = '521016';
const DATE = '2026-11-03';
const CARD_COUNT = 3;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]);

interface Called {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

let calls: Called[] = [];

function envelopePayload(): string {
  const files = Array.from({ length: CARD_COUNT }, (_, i) => ({
    name: `card-0${i + 1}.png`,
    bytes: PNG.length,
  }));
  return JSON.stringify({ ok: true, data: { date: DATE, count: CARD_COUNT, files } });
}

function bodyHtml(html: string): string {
  const match = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  return (match?.[1] ?? '').replace(/<script[\s\S]*?<\/script>/gi, '');
}

const q = <T extends Element>(sel: string): T => document.querySelector<T>(sel)!;
const statusText = (): string => q('#status').textContent ?? '';
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeAll(async () => {
  document.body.innerHTML = bodyHtml(readFileSync('tools/xhs-cards/index.html', 'utf8'));
  await import('../tools/xhs-cards/main.ts');
});

beforeEach(() => {
  calls = [];
  vi.unstubAllGlobals();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
      const call: Called = {
        url: String(url),
        method: (init?.method ?? 'GET').toUpperCase(),
        headers,
        body: typeof init?.body === 'string' ? init.body : undefined,
      };
      calls.push(call);
      if (call.url.includes('/api/xhs/cards')) {
        return new Response(envelopePayload(), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } });
    }),
  );
  q<HTMLInputElement>('#key').value = '';
  q('#grid').replaceChildren();
  q('#status').textContent = '';
  q('#result').setAttribute('hidden', '');
  // 每轮复位"未就绪":按钮被预取逻辑禁用过
  q<HTMLButtonElement>('#save').disabled = true;
  q<HTMLButtonElement>('#zip').disabled = true;
});

const generate = async (): Promise<void> => {
  q<HTMLInputElement>('#key').value = KEY;
  q<HTMLButtonElement>('#go').click();
  await flush();
  await flush();
};

describe('小红书卡片工具', () => {
  it('打开页面日期默认是今天(本地时区)', () => {
    expect(q<HTMLInputElement>('#date').value).toBe(localDateString(new Date()));
  });

  it('没输密钥就点生成 → 不发任何请求', async () => {
    q<HTMLButtonElement>('#go').click();
    await flush();
    expect(calls).toHaveLength(0);
    expect(statusText()).toContain('密钥');
  });

  it('生成成功后渲染全部缩略图,并立刻预取图片', async () => {
    await generate();

    const imgs = q('#grid').querySelectorAll('img');
    expect(imgs).toHaveLength(CARD_COUNT);

    // 一次生成 + 每张图各预取一次
    const cardCalls = calls.filter((c) => c.url.includes('/api/xhs/card?'));
    expect(cardCalls).toHaveLength(CARD_COUNT);
    // 预取完成后按钮可用
    expect(q<HTMLButtonElement>('#save').disabled).toBe(false);
  });

  it('请求里密钥只走 X-Api-Key 头,且不进 URL', async () => {
    await generate();
    const generateCall = calls.find((c) => c.url.includes('/api/xhs/cards'));
    expect(generateCall?.headers['x-api-key']).toBe(KEY);
    expect(generateCall?.url).not.toContain(KEY);
  });

  it('密钥不持久化:生成后输入框被清空,也没写 localStorage', async () => {
    await generate();
    expect(q<HTMLInputElement>('#key').value).toBe('');
    expect(window.localStorage.length).toBe(0);
  });

  it('有系统分享 → 调用一次 share,带上全部文件', async () => {
    const share = vi.fn(async (_data: ShareData) => undefined);
    const canShare = vi.fn(() => true);
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    Object.defineProperty(navigator, 'canShare', { value: canShare, configurable: true });

    await generate();
    q<HTMLButtonElement>('#save').click();
    await flush();

    expect(share).toHaveBeenCalledTimes(1);
    const payload = share.mock.calls[0]?.[0];
    if (payload === undefined) throw new Error('share 没有被调用');
    expect(payload.files).toHaveLength(CARD_COUNT);
    expect(statusText()).toContain('存储图像');
  });

  it('没有系统分享 → 不报错,退回逐张下载', async () => {
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true });

    await generate();
    vi.useFakeTimers();
    try {
      q<HTMLButtonElement>('#save').click();
      // 逐张下载之间要等 DOWNLOAD_GAP_MS,用假定时器推进(不写死毫秒)
      for (let i = 0; i < CARD_COUNT; i += 1) {
        await vi.advanceTimersByTimeAsync(DOWNLOAD_GAP_MS);
      }
      expect(statusText()).toContain('逐张');
    } finally {
      vi.useRealTimers();
    }
  });
});
