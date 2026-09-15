// @vitest-environment happy-dom
/**
 * “重启 DSH”工具的界面行为测试。
 *
 * 这个工具会真的改变系统状态,所以界面上的护栏必须被测到:
 *   1. 没有密钥 / 没有二次确认 → **绝不能**发出重启请求
 *   2. 取消之后暂存的密钥要失效(不能"点过取消还能靠残留状态重启")
 *   3. 确认后:发重启命令 → 轮询到**新**令牌 → 展示新地址(默认打码)
 *   4. 全程不写 localStorage / sessionStorage / cookie
 *
 * 测试全程 mock fetch,不会真的重启任何东西。
 */

import { readFileSync } from 'node:fs';

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const GOOD_KEY = '521016';
const TOKEN_OLD = 'OLDTOKEN_1234567890';
const TOKEN_NEW = 'NEWTOKEN_abcdefghij';

const sleep = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** mock 服务端状态:POST 重启后才开始返回新 token(模拟真实行为) */
let restarted = false;
let restartCalls = 0;
let loginCalls = 0;

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function loginPayload(token: string): unknown {
  return {
    ok: true,
    data: {
      url: `https://dsh.example.com/?token=${token}`,
      host: 'dsh.example.com',
      port: 3080,
      tokenPreview: token.slice(0, 8),
      valid: true,
      checkedAt: '2026-09-15T00:00:00.000Z',
      source: 'dsh-out.log:10',
    },
  };
}

function bodyHtml(html: string): string {
  const match = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  return (match?.[1] ?? '').replace(/<script[\s\S]*?<\/script>/gi, '');
}

const q = <T extends Element>(sel: string): T => document.querySelector<T>(sel)!;

beforeAll(async () => {
  document.body.innerHTML = bodyHtml(readFileSync('tools/dsh-restart/index.html', 'utf8'));
  await import('../tools/dsh-restart/main.ts');
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  restarted = false;
  restartCalls = 0;
  loginCalls = 0;

  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (headers['X-Api-Key'] !== GOOD_KEY) {
      return json(401, { ok: false, error: { code: 'unauthorized', message: '密钥不正确' } });
    }
    if (url === '/api/dsh/restart') {
      restartCalls += 1;
      restarted = true;
      return json(200, {
        ok: true,
        data: {
          restarted: true,
          appName: 'dsh',
          tookMs: 120,
          at: '2026-09-15T00:00:00.000Z',
          note: '旧登录地址与旧登录态已失效,请用新地址重新打开 dsh',
        },
      });
    }
    loginCalls += 1;
    return json(200, loginPayload(restarted ? TOKEN_NEW : TOKEN_OLD));
  }) as unknown as typeof fetch;
});

describe('重启 DSH 工具', () => {
  it('初始状态:没有确认区/进度/结果', () => {
    expect(q<HTMLElement>('#confirmCard').hidden).toBe(true);
    expect(q<HTMLElement>('#progressCard').hidden).toBe(true);
    expect(q<HTMLElement>('#resultCard').hidden).toBe(true);
    expect(q('#status').textContent).toContain('先输入访问密钥');
  });

  it('不填密钥就点主按钮 → 一个请求都不发', async () => {
    q<HTMLInputElement>('#keyInput').value = '';
    q<HTMLButtonElement>('#prepare').click();
    await sleep();
    expect(restartCalls).toBe(0);
    expect(loginCalls).toBe(0);
    expect(q('#status').textContent).toBe('请输入访问密钥');
  });

  it('只点主按钮(未确认)→ 只读取当前状态,不执行重启', async () => {
    q<HTMLInputElement>('#keyInput').value = GOOD_KEY;
    q<HTMLButtonElement>('#prepare').click();
    await sleep(60);

    expect(loginCalls).toBe(1); // 读了一次当前状态
    expect(restartCalls).toBe(0); // 关键:没有重启
    expect(q<HTMLElement>('#confirmCard').hidden).toBe(false);
    expect(q('#infoText').textContent).toContain(TOKEN_OLD.slice(0, 8));
    // 输入框已被清空(密钥只在内存里)
    expect(q<HTMLInputElement>('#keyInput').value).toBe('');
  });

  it('取消 → 不重启;之后再点确认会提示密钥已失效', async () => {
    q<HTMLButtonElement>('#cancel').click();
    expect(q<HTMLElement>('#confirmCard').hidden).toBe(true);

    q<HTMLButtonElement>('#confirm').click();
    await sleep();
    expect(restartCalls).toBe(0);
    expect(q('#status').textContent).toBe('密钥已失效,请重新输入');
  });

  it('确认后:发出重启命令 → 轮询到新令牌 → 展示新地址(默认打码)', async () => {
    // 重新走一遍:输入密钥 → 读状态 → 确认
    q<HTMLInputElement>('#keyInput').value = GOOD_KEY;
    q<HTMLButtonElement>('#prepare').click();
    await sleep(60);
    expect(restartCalls).toBe(0);

    q<HTMLButtonElement>('#confirm').click();
    await sleep(2000); // POST + 一次轮询(间隔 1.2s)

    expect(restartCalls).toBe(1);
    expect(q<HTMLElement>('#resultCard').hidden).toBe(false);
    expect(q('#validBadge').textContent).toBe('校验通过');

    // 默认打码:不出现完整 token
    expect(q('#urlText').textContent).toContain('token=••••');
    expect(q('#urlText').textContent).not.toContain(TOKEN_NEW);

    // 点「显示完整地址」才展开
    q<HTMLButtonElement>('#reveal').click();
    expect(q('#urlText').textContent).toContain(TOKEN_NEW);

    expect(q('#status').textContent).toContain('重启完成');
    // 进度步骤里有已完成的项
    expect(document.querySelectorAll('.steps .step.done').length).toBeGreaterThan(0);
    // 输入框依旧为空
    expect(q<HTMLInputElement>('#keyInput').value).toBe('');
  });

  it('全程不写本地存储(密钥不保存)', () => {
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
  });
});
