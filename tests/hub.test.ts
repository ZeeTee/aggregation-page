// @vitest-environment happy-dom
/**
 * 门户页渲染测试：卡片、搜索、标签过滤。
 *
 * 门户的卡片是运行时用 JS 渲染的（构建期只注入数据），所以必须有 DOM 测试兜底，
 * 否则选择器写错会静默渲染出空白页面。
 */

import { readFileSync } from 'node:fs';

import { beforeAll, describe, expect, it } from 'vitest';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function bodyHtml(html: string): string {
  const match = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  // 去掉 <script src="...main.ts">，避免 happy-dom 去加载源码模块
  return (match?.[1] ?? '').replace(/<script[\s\S]*?<\/script>/gi, '');
}

beforeAll(async () => {
  // vitest 里 import.meta.url 不是 file: 协议，直接用项目根目录读取模板
  document.body.innerHTML = bodyHtml(readFileSync('index.html', 'utf8'));
  await import('../src/hub/main.ts');
});

describe('门户页', () => {
  it('为每个可见工具渲染一张卡片', () => {
    const cards = [...document.querySelectorAll<HTMLAnchorElement>('.tool-card')];
    expect(cards.length).toBe(2);
    expect(cards.map((c) => c.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('时间戳转换'), expect.stringContaining('JSON 格式化')]),
    );
  });

  it('卡片链接指向 /tools/<slug>/ 且带图标与标签', () => {
    const card = document.querySelector<HTMLAnchorElement>('.tool-card');
    expect(card?.getAttribute('href')).toMatch(/^\/tools\/[a-z0-9-]+\/$/);
    expect(card?.querySelector('.icon')?.textContent).toBeTruthy();
    expect(card?.dataset['tags']).toBeTruthy();
  });

  it('标签按钮按工具标签去重生成', () => {
    const tags = [...document.querySelectorAll<HTMLButtonElement>('.tags button')].map(
      (b) => b.textContent,
    );
    expect(tags).toEqual(['时间', '开发', '文本']);
  });

  it('搜索能按关键字过滤卡片', async () => {
    const search = document.querySelector<HTMLInputElement>('#q');
    const count = document.querySelector('#count');
    expect(search).not.toBeNull();
    expect(count?.textContent).toBe('共 2 / 2 个工具');

    search!.value = 'json';
    search!.dispatchEvent(new Event('input'));
    await sleep(200);

    const visible = [...document.querySelectorAll<HTMLElement>('.tool-card')].filter((c) => !c.hidden);
    expect(visible.length).toBe(1);
    expect(visible[0]?.textContent).toContain('JSON 格式化');
    expect(count?.textContent).toBe('共 1 / 2 个工具');

    search!.value = '';
    search!.dispatchEvent(new Event('input'));
    await sleep(200);
    expect(count?.textContent).toBe('共 2 / 2 个工具');
  });

  it('无匹配时显示空状态提示', async () => {
    const search = document.querySelector<HTMLInputElement>('#q');
    search!.value = '不存在的工具名';
    search!.dispatchEvent(new Event('input'));
    await sleep(200);
    expect(document.querySelector<HTMLElement>('#empty')?.hidden).toBe(false);
    search!.value = '';
    search!.dispatchEvent(new Event('input'));
    await sleep(200);
  });

  it('站点标题与文案来自 config.json（构建期注入）', () => {
    expect(document.title).toBe('在线工具箱');
    expect(document.querySelector('#brand')?.textContent).toBe('在线工具箱');
    expect(document.querySelector('#tagline')?.textContent).toContain('小工具');
  });
});
