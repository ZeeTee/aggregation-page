/**
 * 📰 手工新闻 —— 前端逻辑
 * ============================================================================
 * 把一条新闻链接加入 ai-news-daily 的"手工队列",并查看今天已经加进去的新闻。
 *
 * 两个接口(都是 GET/POST /api/news/manual,都需要 X-Api-Key):
 *   GET  → 读队列
 *   POST → 添加一条。**响应里顺带带回刷新后的整个列表**,
 *          所以添加完不需要再发一次 GET —— 鉴权接口限流只有 5 次/分钟,
 *          一次操作只该消耗一个额度。
 *
 * 密钥策略(与其他工具一致):
 *   · 只放在 <input> 里用,不做任何持久化(无 localStorage / cookie)
 *   · 只走 X-Api-Key 请求头,绝不放进 URL
 */

import '../../src/shared/base.css';
import './style.css';

import { ApiError, callApi } from '../../src/shared/api';
import { el, fill, must } from '../../src/shared/dom';
import { toast } from '../../src/shared/toast';
import type {
  ManualNewsAddResult,
  ManualNewsEntry,
  ManualNewsList,
} from '../../src/shared/types';

const API = '/api/news/manual';

const urlInput = must<HTMLInputElement>('#url');
const titleInput = must<HTMLInputElement>('#title');
const summaryInput = must<HTMLTextAreaElement>('#summary');
const noteInput = must<HTMLInputElement>('#note');
const keyInput = must<HTMLInputElement>('#keyInput');
const addButton = must<HTMLButtonElement>('#add');
const refreshButton = must<HTMLButtonElement>('#refresh');
const statusEl = must('#status');
const metaEl = must('#meta');
const listEl = must('#list');
const advanced = must<HTMLDetailsElement>('#advanced');

/** 把后端的 consumedAt / result 翻译成给人看的状态徽章。 */
function statusOf(entry: ManualNewsEntry): { label: string; kind: string } {
  if (entry.result === 'duplicate') return { label: '重复跳过', kind: 'dup' };
  if (entry.consumedAt !== '') return { label: '已并入日报', kind: 'used' };
  return { label: '待用', kind: 'pending' };
}

/** "2026-09-16T00:24:37" → "00:24"(当天)或 "09-16 00:24"(非当天) */
function timeLabel(entry: ManualNewsEntry): string {
  const raw = entry.addedAt;
  const time = raw.slice(11, 16);
  const date = raw.slice(5, 10);
  if (entry.isToday) return time || '—';
  return `${date} ${time}`.trim();
}

function renderEntry(entry: ManualNewsEntry): HTMLElement {
  const badge = statusOf(entry);
  const title = entry.title !== '' ? entry.title : '(未取到标题)';

  const meta: string[] = [timeLabel(entry)];
  meta.push(entry.bodyChars > 0 ? `正文 ${entry.bodyChars} 字` : '未抓到正文');
  if (entry.summary !== '') meta.push('有导语');

  const children: Array<Node | string> = [
    el('span', { class: `badge ${badge.kind}`, text: badge.label }),
    el('a', {
      class: 'title',
      href: entry.url,
      target: '_blank',
      rel: 'noopener noreferrer',
      text: title,
    }),
    el('p', { class: 'meta', text: meta.join(' · ') }),
  ];
  if (entry.note !== '') {
    children.push(el('p', { class: 'note', text: `备注:${entry.note}` }));
  }

  return el('div', { class: 'entry' }, children);
}

function renderEmpty(text: string): void {
  fill(listEl, [el('p', { class: 'empty', text })]);
}

/** 渲染列表:主打"今天添加的",更早仍未出报的单独列出,避免被忽略。 */
function renderList(list: ManualNewsList): void {
  const today = list.entries.filter((e) => e.isToday);
  const olderPending = list.entries.filter(
    (e) => !e.isToday && e.result !== 'duplicate' && e.consumedAt === '',
  );

  metaEl.textContent =
    `今天 ${list.counts.today} 条 · 待用 ${list.counts.pending} 条` +
    (list.counts.duplicate > 0 ? ` · 重复跳过 ${list.counts.duplicate} 条` : '');

  const nodes: HTMLElement[] = [];

  if (today.length === 0) {
    nodes.push(el('p', { class: 'empty', text: '今天还没有添加过新闻。' }));
  } else {
    for (const entry of today) nodes.push(renderEntry(entry));
  }

  if (olderPending.length > 0) {
    nodes.push(el('h3', { class: 'sub', text: `更早添加、尚未出报(${olderPending.length} 条)` }));
    for (const entry of olderPending) nodes.push(renderEntry(entry));
  }

  fill(listEl, nodes);
}

function setStatus(message: string, kind: 'ok' | 'err' | 'warn' | '' = ''): void {
  statusEl.textContent = message;
  statusEl.className = `status ${kind}`.trim();
}

function setBusy(busy: boolean): void {
  addButton.disabled = busy;
  refreshButton.disabled = busy;
  addButton.textContent = busy ? '处理中…' : '添加到日报';
}

/** 把接口错误翻成能直接给用户看的中文。 */
function describe(error: unknown): { message: string; kind: 'err' | 'warn' } {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'unauthorized':
        return { message: '密钥不正确', kind: 'err' };
      case 'api_key_not_configured':
        return { message: '服务端未配置访问密钥,该工具不可用', kind: 'err' };
      case 'python_not_found':
      case 'news_command_failed':
        return { message: '服务端无法访问新闻队列,请查看服务端日志', kind: 'err' };
      case 'add_cooldown':
      case 'rate_limited':
      case 'auth_locked':
        return { message: error.message, kind: 'warn' };
      case 'timeout':
        return { message: '抓取网页超时:可展开「高级选项」自己填标题与导语后重试', kind: 'warn' };
      case 'invalid_url':
      case 'invalid_field':
      case 'invalid_body':
        return { message: error.message, kind: 'err' };
      default:
        return { message: error.message, kind: 'err' };
    }
  }
  return { message: `请求失败:${(error as Error).message}`, kind: 'err' };
}

function clearForm(): void {
  urlInput.value = '';
  titleInput.value = '';
  summaryInput.value = '';
  noteInput.value = '';
  advanced.open = false;
}

async function add(): Promise<void> {
  const url = urlInput.value.trim();
  if (url === '') {
    setStatus('请先填写新闻链接', 'err');
    urlInput.focus();
    return;
  }
  const apiKey = keyInput.value;
  if (apiKey === '') {
    setStatus('请输入访问密钥', 'err');
    keyInput.focus();
    return;
  }

  setBusy(true);
  setStatus('正在抓取标题与正文…');
  try {
    const result = await callApi<ManualNewsAddResult>(API, {
      method: 'POST',
      apiKey,
      body: {
        url,
        title: titleInput.value.trim(),
        summary: summaryInput.value.trim(),
        note: noteInput.value.trim(),
      },
    });
    // 响应对象自带刷新后的列表,不需要再发一次 GET
    renderList(result.list);

    if (result.action === 'added') {
      const name = result.entry?.title !== undefined && result.entry.title !== ''
        ? result.entry.title
        : url;
      setStatus(`✅ 已加入队列:${name}`, 'ok');
      toast('已加入队列');
      clearForm();
    } else if (result.action === 'duplicate') {
      setStatus(`⏭ 未添加:${result.message !== '' ? result.message : '与之前的新闻重复'}`, 'warn');
    } else {
      setStatus(`✗ ${result.message !== '' ? result.message : '链接不合法'}`, 'err');
    }
  } catch (error) {
    const { message, kind } = describe(error);
    setStatus(`✗ ${message}`, kind);
  } finally {
    setBusy(false);
  }
}

async function refresh(): Promise<void> {
  const apiKey = keyInput.value;
  if (apiKey === '') {
    setStatus('请先输入访问密钥,再刷新列表', 'err');
    keyInput.focus();
    return;
  }

  setBusy(true);
  setStatus('正在加载列表…');
  try {
    const list = await callApi<ManualNewsList>(API, { method: 'GET', apiKey });
    renderList(list);
    setStatus('', '');
  } catch (error) {
    const { message, kind } = describe(error);
    setStatus(`✗ ${message}`, kind);
    renderEmpty('加载失败');
  } finally {
    setBusy(false);
  }
}

addButton.addEventListener('click', () => void add());
refreshButton.addEventListener('click', () => void refresh());
// 链接框回车 = 添加;密钥框回车 = 刷新
urlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void add();
});
keyInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void refresh();
});

renderEmpty('输入访问密钥后,点「刷新」加载今天添加的新闻。');
