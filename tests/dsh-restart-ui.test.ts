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

import {
  AUTH_RATE_LIMIT,
  DSH_STARTUP_MS,
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  SETUP_REQUESTS,
} from '../tools/dsh-restart/polling.ts';

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
    // POST 立即返回,之后要等**首次轮询**(间隔 POLL_INTERVAL_MS)拿到新令牌。
    // 这里从常量推导而不是写死毫秒数,免得以后调间隔又把这个用例写挂。
    await sleep(POLL_INTERVAL_MS + 800);

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

/**
 * 轮询预算回归测试(对应一次真实故障)。
 *
 * 故障现场:轮询间隔 1.2 秒、鉴权限流 5 次/分钟,于是"读取旧地址 + 触发重启 +
 * 3 次轮询"在 5.5 秒就耗尽了额度,而 dsh 实测要 **8.6 秒**才把新 token 打印进
 * 日志 —— token 出现的那一刻轮询已经被 429 封死,必然超时。
 *
 * 这里守住的不变量:一次重启流程的最坏鉴权请求数必须放得进服务端额度,
 * 且轮询间隔不能短到在 token 出现之前就把额度烧掉。
 */
describe('重启工具 —— 轮询额度预算', () => {

  it('最坏情况下的鉴权请求数不超过服务端额度', () => {
    const worstCase = SETUP_REQUESTS + Math.ceil(POLL_TIMEOUT_MS / POLL_INTERVAL_MS);
    expect(worstCase).toBeLessThanOrEqual(AUTH_RATE_LIMIT);
  });

  it('轮询间隔足够长:token 出现前不会烧掉超过一半额度', () => {
    // dsh 启动期间会发出去的轮询次数
    const pollsBeforeToken = Math.floor(DSH_STARTUP_MS / POLL_INTERVAL_MS);
    expect(SETUP_REQUESTS + pollsBeforeToken).toBeLessThan(AUTH_RATE_LIMIT / 2);
  });

  it('总超时覆盖得住 dsh 启动时间,并留有余量', () => {
    expect(POLL_TIMEOUT_MS).toBeGreaterThan(DSH_STARTUP_MS * 2);
  });
});
