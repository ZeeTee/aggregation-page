// @vitest-environment happy-dom
/**
 * “手工新闻”工具的界面行为测试。
 *
 * 服务端契约已由 tests/news.test.ts 覆盖,这里只盯**前端自己的逻辑**:
 *   1. 没填链接 / 没输密钥 → **绝不能**发请求
 *   2. 添加成功后表单清空、列表就地刷新(POST 响应自带列表,不再发 GET)
 *   3. 「重复跳过」时**不清空表单**(方便用户对照着改),并给出警告样式
 *   4. 状态徽章由 result / consumedAt 推断:待用 / 已并入日报 / 重复跳过
 *   5. 列表只把"今天"的放主区,更早仍未出报的单独成段(不能被悄悄藏起来)
 *   6. 密钥只走 X-Api-Key 请求头,**绝不**进 URL;且不写 localStorage / cookie
 *
 * 全程 mock fetch,不会真的碰后端。
 */

import { readFileSync } from 'node:fs';

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = '521016';

interface Called {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

let calls: Called[] = [];
/** 下一次请求要返回的响应 */
let respond: (call: Called) => Response;

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'e1',
    url: 'https://example.com/news/1',
    title: '今天加的一条新闻',
    summary: '',
    note: '',
    addedAt: '2026-09-16T10:00:00',
    consumedAt: '',
    result: '',
    bodyChars: 1200,
    isToday: true,
    ...over,
  };
}

function listData(entries: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    today: '2026-09-16',
    queueFile: '/tmp/manual_queue.json',
    entries,
    counts: {
      today: entries.filter((e) => e['isToday'] === true).length,
      pending: entries.filter((e) => e['result'] !== 'duplicate' && e['consumedAt'] === '').length,
      duplicate: entries.filter((e) => e['result'] === 'duplicate').length,
    },
  };
}

function okList(entries: Array<Record<string, unknown>> = [makeEntry()]): Response {
  return json(200, { ok: true, data: listData(entries) });
}

function okAdd(action: string, message = '', entry: unknown = null): Response {
  // 真实后端会把新增的条目放进 entries 里一起返回,这里保持一致
  const entries = action === 'added' && entry !== null ? [entry as Record<string, unknown>] : [];
  return json(200, {
    ok: true,
    data: { action, message, entry, list: listData(entries) },
  });
}

function bodyHtml(html: string): string {
  const match = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  return (match?.[1] ?? '').replace(/<script[\s\S]*?<\/script>/gi, '');
}

const q = <T extends Element>(sel: string): T => document.querySelector<T>(sel)!;

beforeAll(async () => {
  document.body.innerHTML = bodyHtml(readFileSync('tools/manual-news/index.html', 'utf8'));
  await import('../tools/manual-news/main.ts');
});

beforeEach(() => {
  calls = [];
  respond = () => okList();
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
      return respond(call);
    }),
  );
  // 表单复位
  q<HTMLInputElement>('#url').value = '';
  q<HTMLInputElement>('#keyInput').value = '';
  q<HTMLInputElement>('#title').value = '';
  q<HTMLInputElement>('#note').value = '';
  q<HTMLTextAreaElement>('#summary').value = '';
  q('#list').replaceChildren();
  q('#status').textContent = '';
  window.localStorage.clear();
  document.cookie = 'k=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
});

const click = (sel: string): void => q<HTMLButtonElement>(sel).click();
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('手工新闻工具 —— 输入护栏', () => {
  it('没填链接就点添加 → 不发任何请求', async () => {
    q<HTMLInputElement>('#keyInput').value = KEY;
    click('#add');
    await flush();
    expect(calls).toHaveLength(0);
    expect(q('#status').textContent).toContain('链接');
  });

  it('没输密钥就点添加 → 不发任何请求', async () => {
    q<HTMLInputElement>('#url').value = 'https://example.com/a';
    click('#add');
    await flush();
    expect(calls).toHaveLength(0);
    expect(q('#status').textContent).toContain('密钥');
  });

  it('没输密钥就点刷新 → 不发任何请求', async () => {
    click('#refresh');
    await flush();
    expect(calls).toHaveLength(0);
  });
});

describe('手工新闻工具 —— 添加流程', () => {
  it('添加成功:POST 到 /api/news/manual,清空表单,列表就地刷新', async () => {
    respond = () => okAdd('added', '', makeEntry({ title: '刚加的那条' }));
    q<HTMLInputElement>('#url').value = 'https://example.com/a';
    q<HTMLInputElement>('#keyInput').value = KEY;
    click('#add');
    await flush();

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('/api/news/manual');
    expect(call.headers['x-api-key']).toBe(KEY);
    expect(JSON.parse(call.body ?? '{}')).toMatchObject({ url: 'https://example.com/a' });

    // 表单清空(方便连续加下一条)
    expect(q<HTMLInputElement>('#url').value).toBe('');
    // 列表用的是响应里带回来的列表,没有再发 GET
    expect(q('#list').textContent).toContain('刚加的那条');
    expect(q('#status').textContent).toContain('已加入队列');
  });

  it('重复链接:给出警告、**不清空**表单(方便对照着改)', async () => {
    respond = () => okAdd('duplicate', '该链接在 72h 去重记忆里,最近日报已收录过');
    q<HTMLInputElement>('#url').value = 'https://example.com/dup';
    q<HTMLInputElement>('#keyInput').value = KEY;
    click('#add');
    await flush();

    expect(q('#status').textContent).toContain('未添加');
    expect(q('#status').className).toContain('warn');
    expect(q<HTMLInputElement>('#url').value).toBe('https://example.com/dup');
  });

  it('错误码 → 翻成中文提示(401 密钥不正确)', async () => {
    respond = () => json(401, { ok: false, error: { code: 'unauthorized', message: '密钥不正确' } });
    q<HTMLInputElement>('#url').value = 'https://example.com/a';
    q<HTMLInputElement>('#keyInput').value = 'wrong';
    click('#add');
    await flush();
    expect(q('#status').textContent).toContain('密钥不正确');
  });

  it('密钥只走请求头,绝不进 URL', async () => {
    respond = () => okAdd('added');
    q<HTMLInputElement>('#url').value = 'https://example.com/a';
    q<HTMLInputElement>('#keyInput').value = KEY;
    click('#add');
    await flush();
    expect(calls[0]!.url).not.toContain(KEY);
    expect(calls[0]!.url).not.toContain('?');
  });

  it('密钥不做任何持久化(无 localStorage / cookie)', async () => {
    respond = () => okAdd('added');
    q<HTMLInputElement>('#url').value = 'https://example.com/a';
    q<HTMLInputElement>('#keyInput').value = KEY;
    click('#add');
    await flush();
    expect(window.localStorage.length).toBe(0);
    expect(document.cookie).toBe('');
  });
});

describe('手工新闻工具 —— 列表与状态', () => {
  it('状态徽章:待用 / 已并入日报 / 重复跳过', async () => {
    respond = () =>
      okList([
        makeEntry({ id: 'a', title: '待用的那条' }),
        makeEntry({ id: 'b', title: '已并报的那条', consumedAt: '2026-09-16T06:00:00', result: 'included' }),
        makeEntry({ id: 'c', title: '重复的那条', consumedAt: '2026-09-16T06:00:00', result: 'duplicate' }),
      ]);
    q<HTMLInputElement>('#keyInput').value = KEY;
    click('#refresh');
    await flush();

    const badges = [...document.querySelectorAll('.entry .badge')].map((n) => n.textContent);
    expect(badges).toEqual(['待用', '已并入日报', '重复跳过']);
    expect(document.querySelectorAll('.entry .badge.pending')).toHaveLength(1);
    expect(document.querySelectorAll('.entry .badge.used')).toHaveLength(1);
    expect(document.querySelectorAll('.entry .badge.dup')).toHaveLength(1);
  });

  it('今天为空时给出空状态;更早仍未出报的单独成段', async () => {
    respond = () =>
      okList([
        makeEntry({ id: 'old', title: '昨天加的还没出报', isToday: false, addedAt: '2026-09-15T20:00:00' }),
      ]);
    q<HTMLInputElement>('#keyInput').value = KEY;
    click('#refresh');
    await flush();

    expect(q('#list').textContent).toContain('今天还没有添加过新闻');
    expect(q('#list').textContent).toContain('更早添加、尚未出报');
    expect(q('#list').textContent).toContain('昨天加的还没出报');
  });

  it('刷新用 GET,并显示统计', async () => {
    respond = () => okList([makeEntry(), makeEntry({ id: 'x', isToday: false, result: 'duplicate' })]);
    q<HTMLInputElement>('#keyInput').value = KEY;
    click('#refresh');
    await flush();
    expect(calls[0]!.method).toBe('GET');
    expect(q('#meta').textContent).toContain('今天 1 条');
    expect(q('#meta').textContent).toContain('重复跳过 1 条');
  });

  it('抓不到正文的条目会标注出来', async () => {
    respond = () => okList([makeEntry({ bodyChars: 0 })]);
    q<HTMLInputElement>('#keyInput').value = KEY;
    click('#refresh');
    await flush();
    expect(q('#list').textContent).toContain('未抓到正文');
  });
});
