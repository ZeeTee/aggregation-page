/**
 * 小红书卡片 —— 浏览、下载,以及(必要时)强制重新生成。
 *
 * 卡片已经并进日报流程:cron 每天 07:00 自动生成 `output/<日期>/xhs/`,并随
 * `output/` 一起入库。所以这里的**常态是浏览和下载**,不需要密钥:
 *
 *   1. 打开页面 → `GET /api/xhs/dates` 填日期下拉框(默认最新一天)
 *   2. 选日期   → `GET /api/xhs/cards?date=` 只读地列出这一天已生成的文件
 *   3. 下载     → 「保存到相册」(系统分享面板)或 ZIP
 *   4. 强制重做 → `POST /api/xhs/cards`(需要密钥,带 force)
 *
 * 密钥策略(站点统一要求):每次操作都要重新输入,**不存** localStorage /
 * sessionStorage / cookie,只走 `X-Api-Key` 请求头。
 */

import '../../src/shared/base.css';
import './style.css';

import { ApiError, callApi } from '../../src/shared/api';
import { must } from '../../src/shared/dom';
import { toast } from '../../src/shared/toast';
import type { XhsCardsResult, XhsDates } from '../../src/shared/types';
import { DOWNLOAD_GAP_MS } from './constants';
import { canShareFiles, type ShareCapable } from './share';
import { buildZip } from './zip';

const dateSelect = must<HTMLSelectElement>('#date');
const reloadButton = must<HTMLButtonElement>('#reload');
const keyInput = must<HTMLInputElement>('#key');
const regenButton = must<HTMLButtonElement>('#regen');
const saveButton = must<HTMLButtonElement>('#save');
const zipButton = must<HTMLButtonElement>('#zip');
const statusEl = must('#status');
const summaryEl = must('#summary');
const resultEl = must('#result');
const gridEl = must('#grid');

/** 当前选中日期的结果;null 表示还没加载出来 */
let current: XhsCardsResult | null = null;
/** 缓存击穿参数:重新生成后同一文件名内容会变,必须让浏览器重新取 */
let cacheBust = Date.now();

/**
 * 已加载的图片(加载某天之后立刻预取)。
 *
 * 为什么要预取:**iOS 要求 navigator.share 必须在用户手势里同步调用**,
 * 如果点了按钮才开始 fetch,手势就丢了,会抛 NotAllowedError。
 * 8 张 × 约 250KB ≈ 2MB,可以接受;顺带 ZIP 也不用再等网络。
 */
let blobs: File[] = [];
let ready = false;
/** 正在加载的批次号,避免快速切换日期时旧请求覆盖新结果 */
let loadToken = 0;

function cardUrl(date: string, name: string, bust: number): string {
  const params = new URLSearchParams({ date, name, t: String(bust) });
  return `/api/xhs/card?${params.toString()}`;
}

function setStatus(text: string, kind: 'hint' | 'ok' | 'err' = 'hint'): void {
  statusEl.textContent = text;
  statusEl.className = kind === 'hint' ? 'hint' : kind;
}

/** 把接口错误转成一句人话 */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'card_not_found') {
      return '这一天没有卡片:可能还没生成(每天 07:00 生成),或已超过 7 天被清理。';
    }
    if (error.code === 'generate_cooldown') return error.message;
    if (error.code === 'xhs_command_failed') return '重新生成失败,详情见服务端日志。';
    if (error.code === 'invalid_date') return '日期格式不对,应为 YYYY-MM-DD。';
    return `${error.message}(${error.code})`;
  }
  return error instanceof Error ? error.message : String(error);
}

// ------------------------------------------------------------------ 日期下拉框
async function loadDates(preferDate?: string): Promise<void> {
  setStatus('读取可用日期…');
  try {
    const data = await callApi<XhsDates>('/api/xhs/dates');
    dateSelect.replaceChildren();
    if (data.dates.length === 0) {
      setStatus('还没有任何卡片。日报流程每天 07:00 生成,也可以在下面手动生成一次。', 'err');
      resultEl.hidden = true;
      current = null;
      return;
    }
    for (const entry of data.dates) {
      const option = document.createElement('option');
      option.value = entry.date;
      option.textContent = `${entry.date}(${entry.count} 张)`;
      dateSelect.append(option);
    }
    const wanted = preferDate ?? data.dates[0]?.date ?? '';
    if (wanted !== '') dateSelect.value = wanted;
    setStatus(`共 ${data.dates.length} 天可用`);
    await loadCards();
  } catch (error) {
    setStatus(describeError(error), 'err');
  }
}

// ------------------------------------------------------------------ 读取某天
async function loadCards(): Promise<void> {
  const date = dateSelect.value;
  if (date === '') return;
  loadToken += 1;
  const token = loadToken;
  setStatus(`读取 ${date} 的卡片…`);
  resultEl.hidden = true;
  current = null;
  try {
    const data = await callApi<XhsCardsResult>(
      `/api/xhs/cards?date=${encodeURIComponent(date)}`);
    if (token !== loadToken) return;   // 用户已经切到别的日期了
    current = data;
    cacheBust = Date.now();
    render();
    setStatus(`已加载 ${data.count} 张`, 'ok');
  } catch (error) {
    if (token !== loadToken) return;
    setStatus(describeError(error), 'err');
  }
}

// ------------------------------------------------------------------ 渲染与预取
function render(): void {
  gridEl.replaceChildren();
  if (current === null) {
    resultEl.hidden = true;
    return;
  }
  resultEl.hidden = false;
  summaryEl.textContent = `${current.date} · 共 ${current.count} 张`;
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

async function prefetch(): Promise<void> {
  blobs = [];
  ready = false;
  saveButton.disabled = true;
  zipButton.disabled = true;
  if (current === null) return;
  const snapshot = current;
  try {
    for (const file of snapshot.files) {
      const response = await fetch(cardUrl(snapshot.date, file.name, cacheBust));
      if (!response.ok) throw new Error(`${file.name} 取图失败(HTTP ${response.status})`);
      blobs.push(new File([await response.blob()], `${snapshot.date}-${file.name}`,
        { type: 'image/png' }));
    }
    if (snapshot !== current) return;   // 期间切换了日期,丢弃这次预取
    ready = true;
  } catch (error) {
    setStatus(`图片准备失败:${describeError(error)}`, 'err');
  } finally {
    saveButton.disabled = !ready;
    zipButton.disabled = !ready;
  }
}

// ------------------------------------------------------------------ 下载
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

// ------------------------------------------------------------------ 强制重做
async function regenerate(): Promise<void> {
  const date = dateSelect.value;
  if (date === '') {
    setStatus('还没有可选的日期', 'err');
    return;
  }
  const apiKey = keyInput.value.trim();
  if (apiKey === '') {
    setStatus('重新生成需要访问密钥', 'err');
    keyInput.focus();
    return;
  }
  regenButton.disabled = true;
  setStatus(`正在重新生成 ${date}(约 3 秒)…`);
  try {
    await callApi<XhsCardsResult>('/api/xhs/cards', {
      method: 'POST',
      body: { date, force: true },
      apiKey,
    });
    void toast('已重新生成');
    await loadDates(date);
  } catch (error) {
    setStatus(describeError(error), 'err');
  } finally {
    // 无论成败都清掉密钥:站点约定每次操作都要重新输入
    keyInput.value = '';
    regenButton.disabled = false;
  }
}

// ------------------------------------------------------------------ 事件
dateSelect.addEventListener('change', () => void loadCards());
reloadButton.addEventListener('click', () => void loadDates(dateSelect.value === '' ? undefined : dateSelect.value));
saveButton.addEventListener('click', () => void saveToAlbum());
zipButton.addEventListener('click', () => void downloadZip());
regenButton.addEventListener('click', () => void regenerate());
keyInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void regenerate();
});

void loadDates();
