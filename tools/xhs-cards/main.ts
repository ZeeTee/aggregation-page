/**
 * 小红书卡片 —— 按当日日报生成图文卡片并下载。
 *
 * 生成在后端(调 ai-news-daily 的 make_cards),这里只负责:
 *   1. 收密钥与日期,POST `/api/xhs/cards`
 *   2. 把返回的图片列出来(`<img>` 指向公开的 `/api/xhs/card`)
 *   3. 「打包下载全部」用本目录的 zip.ts 在浏览器内拼 ZIP(零依赖)
 *
 * 密钥策略(站点统一要求,不要"优化"掉):每次操作都要重新输入,
 * **不存** localStorage / sessionStorage / cookie,只走 `X-Api-Key` 请求头。
 */

import '../../src/shared/base.css';
import './style.css';

import { ApiError, callApi } from '../../src/shared/api';
import { must } from '../../src/shared/dom';
import { toast } from '../../src/shared/toast';
import type { XhsCardsResult } from '../../src/shared/types';
import { DOWNLOAD_GAP_MS } from './constants';
import { localDateString } from './date';
import { canShareFiles, type ShareCapable } from './share';
import { buildZip } from './zip';

const dateInput = must<HTMLInputElement>('#date');
const keyInput = must<HTMLInputElement>('#key');
const goButton = must<HTMLButtonElement>('#go');
const zipButton = must<HTMLButtonElement>('#zip');
const saveButton = must<HTMLButtonElement>('#save');
const statusEl = must('#status');
const summaryEl = must('#summary');
const resultEl = must('#result');
const gridEl = must('#grid');

/** 当前结果;null 表示还没生成过 */
let current: XhsCardsResult | null = null;
/** 缓存击穿参数:重新生成后同一文件名内容会变,必须让浏览器重新取 */
let cacheBust = Date.now();

/**
 * 生成后立刻把图片拉进内存。
 *
 * 两个原因:
 *   1. **iOS 要求 navigator.share 必须在用户手势里同步调用** —— 如果点按钮后
 *      才开始 fetch,手势就丢了,share 会抛 NotAllowedError;
 *   2. 预取之后 ZIP 打包也不用再等网络。
 * 8 张 × 约 250KB ≈ 2MB,可以接受。
 */
let blobs: File[] = [];
let ready = false;


const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 日期默认填**今天**(本地时区)。清空它则回退成"最新一天"。
dateInput.value = localDateString(new Date());

/** 拼一张卡片的访问地址(`<img src>` 与下载链接共用) */
export function cardUrl(date: string, name: string, bust: number): string {
  const params = new URLSearchParams({ date, name, t: String(bust) });
  return `/api/xhs/card?${params.toString()}`;
}

function setStatus(text: string, kind: 'hint' | 'ok' | 'err' = 'hint'): void {
  statusEl.textContent = text;
  statusEl.className = kind === 'hint' ? 'hint' : kind;
}

/** 把接口错误转成一句人话(429 冷却要带上剩余秒数) */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'generate_cooldown') return error.message;
    if (error.code === 'xhs_command_failed') {
      return '生成失败:这一天还没有日报缓存。今天的日报通常 07:00 之后才有,可换前一天试试。';
    }
    if (error.code === 'invalid_date') return '日期格式不对,应为 YYYY-MM-DD。';
    return `${error.message}(${error.code})`;
  }
  return error instanceof Error ? error.message : String(error);
}

function render(): void {
  gridEl.replaceChildren();
  if (current === null) {
    resultEl.hidden = true;
    return;
  }
  resultEl.hidden = false;
  summaryEl.textContent = `${current.date} · 共 ${current.count} 张`
    + (current.reused === true ? '(复用已生成的图片,没有重新渲染)' : '');
  for (const file of current.files) {
    const url = cardUrl(current.date, file.name, cacheBust);

    const cell = document.createElement('div');
    cell.className = 'cell';

    const img = document.createElement('img');
    img.src = url;
    img.alt = file.name;
    img.loading = 'lazy';

    const link = document.createElement('a');
    link.href = url;
    link.download = `${current.date}-${file.name}`;
    link.textContent = `下载 ${file.name}`;

    cell.append(img, link);
    gridEl.append(cell);
  }
  void prefetch();
}

async function generate(): Promise<void> {
  const apiKey = keyInput.value.trim();
  if (apiKey === '') {
    setStatus('请先输入访问密钥', 'err');
    keyInput.focus();
    return;
  }
  const rawDate = dateInput.value.trim();
  if (rawDate !== '' && !DATE_RE.test(rawDate)) {
    setStatus('日期格式应为 YYYY-MM-DD', 'err');
    return;
  }

  // 无论成败都清掉密钥输入框:站点约定每次操作都要重新输入
  goButton.disabled = true;
  setStatus('生成中,约需 3 秒…');
  try {
    const data = await callApi<XhsCardsResult>('/api/xhs/cards', {
      method: 'POST',
      body: rawDate === '' ? {} : { date: rawDate },
      apiKey,
    });
    current = data;
    cacheBust = Date.now();
    render();
    setStatus(`已生成 ${data.count} 张`, 'ok');
    toast('卡片生成完成');
  } catch (error) {
    setStatus(describeError(error), 'err');
  } finally {
    keyInput.value = '';
    goButton.disabled = false;
  }
}

async function prefetch(): Promise<void> {
  blobs = [];
  ready = false;
  saveButton.disabled = true;
  zipButton.disabled = true;
  if (current === null) return;
  try {
    for (const file of current.files) {
      const response = await fetch(cardUrl(current.date, file.name, cacheBust));
      if (!response.ok) throw new Error(`${file.name} 取图失败(HTTP ${response.status})`);
      blobs.push(new File([await response.blob()], `${current.date}-${file.name}`,
        { type: 'image/png' }));
    }
    ready = true;
  } catch (error) {
    setStatus(`图片准备失败:${describeError(error)}`, 'err');
  } finally {
    saveButton.disabled = !ready;
    zipButton.disabled = !ready;
  }
}

/** 退回逐张下载(桌面浏览器,或系统不支持分享时) */
async function downloadEach(): Promise<void> {
  if (current === null) return;
  for (const file of current.files) {
    const link = document.createElement('a');
    link.href = cardUrl(current.date, file.name, cacheBust);
    link.download = `${current.date}-${file.name}`;
    document.body.append(link);
    link.click();
    link.remove();
    await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_GAP_MS));
  }
  setStatus('已逐张开始下载(若浏览器只允许保存第一个,请改用长按图片保存)', 'hint');
}

/**
 * 保存到相册:优先走系统分享面板(手机上选「存储图像」即进相册),
 * 不支持分享就退回逐张下载。
 */
async function saveToAlbum(): Promise<void> {
  if (current === null || !ready) {
    setStatus('图片还在准备中,请稍候…', 'err');
    return;
  }
  const nav = navigator as unknown as ShareCapable & {
    share?: (data: ShareData) => Promise<void>;
  };
  if (canShareFiles(nav, blobs)) {
    try {
      await nav.share?.({ files: blobs, title: `AI 大模型行业日报 · ${current.date}` });
      setStatus('已打开系统面板,选「存储图像」即可存进相册', 'ok');
      return;
    } catch (error) {
      // 用户主动取消不算失败
      if ((error as Error).name === 'AbortError') {
        setStatus('已取消');
        return;
      }
      // 其他异常(比如手势丢失)就退回逐张下载
    }
  }
  await downloadEach();
}

async function downloadZip(): Promise<void> {
  if (current === null) return;
  zipButton.disabled = true;
  setStatus('打包中…');
  try {
    const entries = [];
    for (const file of blobs) {
      entries.push({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) });
    }
    const zip = buildZip(entries);
    const blob = new Blob([zip as BlobPart], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `xhs-cards-${current.date}.zip`;
    link.click();
    URL.revokeObjectURL(url);
    setStatus(`已打包 ${entries.length} 张`, 'ok');
  } catch (error) {
    setStatus(`打包失败:${describeError(error)}`, 'err');
  } finally {
    zipButton.disabled = false;
  }
}

goButton.addEventListener('click', () => void generate());
saveButton.addEventListener('click', () => void saveToAlbum());
zipButton.addEventListener('click', () => void downloadZip());
keyInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void generate();
});
