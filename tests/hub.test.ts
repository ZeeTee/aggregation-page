// @vitest-environment happy-dom
/**
 * 门户页渲染测试：卡片、搜索、标签过滤。
 *
 * 门户的卡片是运行时用 JS 渲染的（构建期只注入数据），所以必须有 DOM 测试兜底，
 * 否则选择器写错会静默渲染出空白页面。
 *
 * 期望值一律从 tools/ 目录**动态推导**，这样新增工具不需要改测试。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { scanTools } from '../src/build/tools.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const expected = scanTools(resolve('tools')).visible;
const keywordsOf = (name: string, description: string, tags: string[]): string =>
  [name, description, ...tags].join(' ').toLowerCase();
const jsonMatches = expected.filter((t) =>
  keywordsOf(t.name, t.description, t.tags).includes('json'),
).length;
const allTags = [...new Set(expected.flatMap((t) => t.tags))];

function bodyHtml(html: string): string {
  const match = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  // 去掉 <script src="...main.ts">，避免 happy-dom 去加载源码模块
  return (match?.[1] ?? '').replace(/<script[\s\S]*?<\/script>/gi, '');
}

function visibleCards(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.tool-card')].filter((c) => !c.hidden);
}

beforeAll(async () => {
  // vitest 里 import.meta.url 不是 file: 协议，直接用项目根目录读取模板
  document.body.innerHTML = bodyHtml(readFileSync('index.html', 'utf8'));
  await import('../src/hub/main.ts');
});

describe('门户页', () => {
  it('为每个可见工具渲染一张卡片', () => {
    const cards = [...document.querySelectorAll<HTMLAnchorElement>('.tool-card')];
    expect(cards.length).toBe(expected.length);
    for (const tool of expected) {
      expect(cards.some((c) => c.textContent?.includes(tool.name))).toBe(true);
    }
  });

  it('卡片链接指向 /tools/<slug>/ 且带图标与标签', () => {
    for (const card of document.querySelectorAll<HTMLAnchorElement>('.tool-card')) {
      expect(card.getAttribute('href')).toMatch(/^\/tools\/[a-z0-9-]+\/$/);
      expect(card.querySelector('.icon')?.textContent).toBeTruthy();
      expect(card.dataset['kw']).toBeTruthy();
    }
  });

  it('需要后端的工具会显示「需服务端」标记', () => {
    const apiTools = expected.filter((t) => t.api === true);
    const badges = [...document.querySelectorAll('.api-badge')];
    expect(badges.length).toBe(apiTools.length);
  });

  it('标签按钮按工具标签去重生成', () => {
    const tags = [...document.querySelectorAll<HTMLButtonElement>('.tags button')].map(
      (b) => b.textContent,
    );
    expect(tags).toEqual(allTags);
  });

  it('搜索能按关键字过滤卡片', async () => {
    const search = document.querySelector<HTMLInputElement>('#q');
    const count = document.querySelector('#count');
    expect(search).not.toBeNull();
    expect(count?.textContent).toBe(`共 ${expected.length} / ${expected.length} 个工具`);

    search!.value = 'json';
    search!.dispatchEvent(new Event('input'));
    await sleep(200);

    expect(visibleCards().length).toBe(jsonMatches);
    expect(count?.textContent).toBe(`共 ${jsonMatches} / ${expected.length} 个工具`);

    search!.value = '';
    search!.dispatchEvent(new Event('input'));
    await sleep(200);
    expect(count?.textContent).toBe(`共 ${expected.length} / ${expected.length} 个工具`);
  });

  it('无匹配时显示空状态提示', async () => {
    const search = document.querySelector<HTMLInputElement>('#q');
    search!.value = '绝对不存在的工具名 xyzzy';
    search!.dispatchEvent(new Event('input'));
    await sleep(200);
    expect(document.querySelector<HTMLElement>('#empty')?.hidden).toBe(false);
    expect(visibleCards().length).toBe(0);

    search!.value = '';
    search!.dispatchEvent(new Event('input'));
    await sleep(200);
    expect(document.querySelector<HTMLElement>('#empty')?.hidden).toBe(true);
  });

  it('站点标题与文案来自 config.json（构建期注入）', () => {
    // 首页不再单独放站点名那一行(避免与浏览器标签重复),标题只体现在 document.title
    expect(document.title).toBe('在线工具箱');
    expect(document.querySelector('#brand')).toBeNull();
    expect(document.querySelector('#tagline')?.textContent).toContain('小工具');
  });

  it('首页结构:英雄区 + 搜索框 + 卡片网格,且卡片带入场动画序号', () => {
    expect(document.querySelector('.hero')).not.toBeNull();
    expect(document.querySelector('.hero-search #q')).not.toBeNull();
    const first = document.querySelector<HTMLElement>('.tool-card');
    expect(first?.style.getPropertyValue('--i')).toBe('0');
  });
});
