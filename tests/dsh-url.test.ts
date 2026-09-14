// @vitest-environment happy-dom
/**
 * DSH 登录地址工具的行为测试(重点是密钥策略)。
 *
 * 要求的策略是:**每次获取都要输入密钥,且不做任何保存**。
 * 这里把三件事钉死:
 *   1. 不往 localStorage / sessionStorage 写任何东西
 *   2. 输入框为空时不发请求
 *   3. 请求结束(无论成功失败)输入框被清空,下次必须重新输入
 */

import { readFileSync } from 'node:fs';

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const GOOD_KEY = '521016';
const TOKEN = 'TOKEN_abcdef12';
const sleep = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface RecordedCall {
  url: string;
  apiKey: string | undefined;
}

let calls: RecordedCall[] = [];

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function bodyHtml(html: string): string {
  const match = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  return (match?.[1] ?? '').replace(/<script[\s\S]*?<\/script>/gi, '');
}

const keyInput = (): HTMLInputElement => document.querySelector<HTMLInputElement>('#keyInput')!;
const status = (): HTMLElement => document.querySelector<HTMLElement>('#status')!;
const resultCard = (): HTMLElement => document.querySelector<HTMLElement>('#resultCard')!;
const urlText = (): HTMLElement => document.querySelector<HTMLElement>('#urlText')!;

beforeAll(async () => {
  document.body.innerHTML = bodyHtml(readFileSync('tools/dsh-url/index.html', 'utf8'));
  await import('../tools/dsh-url/main.ts');
});

beforeEach(() => {
  calls = [];
  localStorage.clear();
  sessionStorage.clear();
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(input), apiKey: headers['X-Api-Key'] });
    if (headers['X-Api-Key'] !== GOOD_KEY) {
      return jsonResponse(401, { ok: false, error: { code: 'unauthorized', message: '密钥不正确' } });
    }
    return jsonResponse(200, {
      ok: true,
      data: {
        url: `https://dsh.example.com/?token=${TOKEN}`,
        host: 'dsh.example.com',
        port: 3080,
        tokenPreview: TOKEN.slice(0, 8),
        valid: true,
        checkedAt: '2026-09-15T00:00:00.000Z',
        source: 'dsh-out.log:10',
      },
    });
  }) as unknown as typeof fetch;
});

describe('DSH 登录地址工具', () => {
  it('初始状态:未展示结果,提示需要输入密钥', () => {
    expect(resultCard().hidden).toBe(true);
    expect(status().textContent).toContain('每次获取都需输入');
  });

  it('输入框为空时点按钮:不发请求,提示输入密钥', async () => {
    keyInput().value = '';
    document.querySelector<HTMLButtonElement>('#fetch')!.click();
    await sleep();
    expect(calls).toHaveLength(0);
    expect(status().textContent).toBe('请输入访问密钥');
  });

  it('密钥错误:提示不正确,不展示结果,并清空输入框', async () => {
    keyInput().value = '000000';
    document.querySelector<HTMLButtonElement>('#fetch')!.click();
    await sleep();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.apiKey).toBe('000000');
    expect(status().textContent).toBe('密钥不正确');
    expect(resultCard().hidden).toBe(true);
    expect(keyInput().value).toBe('');
  });

  it('密钥正确:展示打码地址,请求头携带 X-Api-Key,输入框被清空', async () => {
    keyInput().value = GOOD_KEY;
    document.querySelector<HTMLButtonElement>('#fetch')!.click();
    await sleep();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/dsh/login-url');
    expect(calls[0]?.apiKey).toBe(GOOD_KEY);
    expect(status().textContent).toBe('获取成功');
    expect(resultCard().hidden).toBe(false);
    // 默认打码:不直接显示完整 token
    expect(urlText().textContent).toContain('token=••••');
    expect(urlText().textContent).not.toContain(TOKEN);
    // 用后即清
    expect(keyInput().value).toBe('');
  });

  it('密钥不会被保存:localStorage / sessionStorage 始终为空', async () => {
    keyInput().value = GOOD_KEY;
    document.querySelector<HTMLButtonElement>('#fetch')!.click();
    await sleep();

    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
  });

  it('每次获取都必须重新输入:清空后再次点击不会发请求', async () => {
    keyInput().value = GOOD_KEY;
    document.querySelector<HTMLButtonElement>('#fetch')!.click();
    await sleep();
    expect(calls).toHaveLength(1);
    expect(keyInput().value).toBe('');

    // 第二次直接点(没有重新输入)→ 不应该发请求
    document.querySelector<HTMLButtonElement>('#fetch')!.click();
    await sleep();
    expect(calls).toHaveLength(1);
    expect(status().textContent).toBe('请输入访问密钥');
  });

  it('可以点「显示完整地址」查看完整 token', async () => {
    keyInput().value = GOOD_KEY;
    document.querySelector<HTMLButtonElement>('#fetch')!.click();
    await sleep();
    document.querySelector<HTMLButtonElement>('#reveal')!.click();
    expect(urlText().textContent).toContain(TOKEN);
    document.querySelector<HTMLButtonElement>('#reveal')!.click();
    expect(urlText().textContent).not.toContain(TOKEN);
  });
});
