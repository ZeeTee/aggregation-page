/** 门户页：渲染工具卡片 + 搜索 + 标签过滤（构建期注入清单，运行时无需请求接口）。 */

import { site } from 'virtual:site';
import { tools } from 'virtual:tools';

import '../shared/base.css';
import './hub.css';

import { debounce, el, fill, must } from '../shared/dom';
import type { ToolMeta } from '../shared/types';

function card(tool: ToolMeta): HTMLAnchorElement {
  const name = el('div', { class: 'name' });
  name.append(tool.name);
  if (tool.status === 'wip') name.append(el('span', { class: 'wip', text: '开发中' }));
  if (tool.api) name.append(el('span', { class: 'api-badge', text: '需服务端' }));

  const children: Array<Node | string> = [
    el('div', { class: 'icon', text: tool.icon }),
    name,
    el('p', { class: 'desc', text: tool.description }),
  ];
  if (tool.tags.length > 0) {
    children.push(el('p', { class: 'tags-line', text: tool.tags.join(' · ') }));
  }

  return el(
    'a',
    {
      class: 'tool-card',
      href: `/tools/${tool.slug}/`,
      'data-kw': [tool.name, tool.description, ...tool.tags].join(' ').toLowerCase(),
      'data-tags': tool.tags.join(','),
    },
    children,
  );
}

function main(): void {
  document.title = site.title;
  // 页面顶部不再单独放站点名(避免与浏览器标签重复),只显示一句副标题
  must('#tagline').textContent = site.subtitle || site.description;
  must('#foot').textContent = site.footer;

  const grid = must('#grid');
  const empty = must('#empty');
  const count = must('#count');
  const search = must<HTMLInputElement>('#q');
  const tagBox = must('#tags');

  const cards = tools.map((tool, index) => {
    const node = card(tool);
    // 入场动画的错位延迟(--i 由 CSS 的 animation-delay 使用)
    node.style.setProperty('--i', String(index));
    grid.append(node);
    return node;
  });

  // 标签过滤按钮
  const allTags = [...new Set(tools.flatMap((t) => t.tags))];
  let activeTag = '';
  const tagButtons = allTags.map((tag) => {
    const button = el('button', { type: 'button', text: tag, 'data-tag': tag });
    button.addEventListener('click', () => {
      activeTag = activeTag === tag ? '' : tag;
      for (const other of tagButtons) other.classList.toggle('on', other.dataset['tag'] === activeTag);
      apply();
    });
    tagBox.append(button);
    return button;
  });

  function apply(): void {
    const keyword = search.value.trim().toLowerCase();
    let shown = 0;
    for (const node of cards) {
      const okKeyword = keyword === '' || (node.dataset['kw'] ?? '').includes(keyword);
      const okTag = activeTag === '' || (node.dataset['tags'] ?? '').split(',').includes(activeTag);
      const ok = okKeyword && okTag;
      node.hidden = !ok;
      if (ok) shown += 1;
    }
    count.textContent = `共 ${shown} / ${cards.length} 个工具`;
    empty.hidden = shown > 0;
  }

  search.addEventListener('input', debounce(apply, 80));
  document.addEventListener('keydown', (event) => {
    if (event.key === '/' && document.activeElement !== search) {
      event.preventDefault();
      search.focus();
    }
  });

  if (cards.length === 0) {
    fill(grid, [el('p', { class: 'empty', text: '还没有工具：在 tools/ 下新建目录并放入 tool.json 与 index.html。' })]);
  }
  apply();
}

main();
