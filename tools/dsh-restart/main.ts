/**
 * 🔄 重启 DSH —— 前端逻辑
 * ============================================================================
 * 这是站内**唯一会改变系统状态**的工具,整个流程按"先看清楚、再确认、最后才动手"设计:
 *
 *   ① 输入密钥 → 点「重启 DSH…」
 *   ② 前端先用密钥读一次当前登录地址(顺便验证密钥;顺便记下"重启前的 token 前缀")
 *   ③ 显示确认区 → 用户点「确认重启」才真正发请求
 *   ④ POST /api/dsh/restart → 服务端执行固定的 `pm2 restart dsh`
 *   ⑤ 轮询 /api/dsh/login-url,直到 token 前缀变了且校验通过(说明新进程起来了)
 *   ⑥ 展示新地址(默认打码)+ 复制 / 直接打开
 *
 * 三条与 dsh-url 工具一致的约定:
 *   · 密钥不保存(不写 localStorage/sessionStorage/cookie);本流程需要跨两次请求用密钥,
 *     所以只在内存变量 pendingKey 里暂存,**流程结束立即清空**
 *   · 密钥只走 X-Api-Key 请求头,绝不放进 URL
 *   · 新地址默认打码(root 级凭据)
 *
 * 与 index.html 的契约(must() 找不到会直接抛错):
 *   #keyInput #prepare #status #infoCard #infoText #confirmCard #confirm #cancel
 *   #progressCard #steps #resultCard #urlText #reveal #copy #open #validBadge #meta
 */

import '../../src/shared/base.css';
import './style.css';

import { ApiError, callApi } from '../../src/shared/api';
import {
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  RATE_LIMIT_BACKOFF_MS,
} from './polling';
import { copyText } from '../../src/shared/clipboard';
import { must } from '../../src/shared/dom';
import { toast } from '../../src/shared/toast';
import type { DshLoginUrl, DshRestartResult } from '../../src/shared/types';

// ---------------------------------------------------------------- 常量
/** 轮询新地址的间隔与总时长:dsh 重启通常 1–3 秒出新 token */


// ---------------------------------------------------------------- DOM
const keyInput = must<HTMLInputElement>('#keyInput');
const prepareButton = must<HTMLButtonElement>('#prepare');
const status = must('#status');
const infoCard = must('#infoCard');
const infoText = must('#infoText');
const confirmCard = must('#confirmCard');
const confirmButton = must<HTMLButtonElement>('#confirm');
const progressCard = must('#progressCard');
const stepsBox = must('#steps');
const resultCard = must('#resultCard');
const urlText = must('#urlText');
const revealButton = must<HTMLButtonElement>('#reveal');
const validBadge = must('#validBadge');
const meta = must('#meta');

// ---------------------------------------------------------------- 状态
/** 本次流程内暂存的密钥(内存变量,流程结束清空;绝不落盘) */
let pendingKey = '';
/** 重启前的 token 前缀:轮询时用它判断"换了新令牌" */
let previousPreview = '';
let newUrl: DshLoginUrl | null = null;
let revealed = false;
let running = false;

// ---------------------------------------------------------------- 小工具

function setStatus(message: string, kind: 'ok' | 'err' | '' = ''): void {
  status.textContent = message;
  status.className = `status ${kind}`;
}

/** 追加一个进度步骤;state 决定样式(doing 转圈、done 打勾、warn 黄色警示)。 */
function addStep(text: string, state: 'doing' | 'done' | 'warn'): void {
  const item = document.createElement('li');
  item.className = `step ${state}`;
  item.textContent = text;
  stepsBox.append(item);
  item.scrollIntoView({ block: 'nearest' });
}

/** 只改最后一步的状态,避免"上一步还在转圈"。 */
function finishLastStep(text: string, state: 'done' | 'warn'): void {
  const last = stepsBox.lastElementChild;
  if (last === null) return;
  last.className = `step ${state}`;
  last.textContent = text;
}

function maskUrl(url: string): string {
  const index = url.indexOf('token=');
  return index < 0 ? url : `${url.slice(0, index)}token=${'•'.repeat(12)}`;
}

function renderResult(): void {
  if (newUrl === null) return;
  urlText.textContent = revealed ? newUrl.url : maskUrl(newUrl.url);
  revealButton.textContent = revealed ? '隐藏' : '显示完整地址';
  validBadge.textContent = newUrl.valid ? '校验通过' : '未通过校验';
  meta.textContent =
    `token 前缀 ${newUrl.tokenPreview}… · 校验于 ${new Date(newUrl.checkedAt).toLocaleTimeString()} · ` +
    `来源 ${newUrl.source}`;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 把 ApiError 映射成中文提示(错误码定义见 server/api.ts 与 server/routes/dsh-restart.ts)。 */
function describe(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'unauthorized') return '密钥不正确';
    if (error.code === 'api_key_not_configured') return '服务端未配置密钥(.env 里的 TOOLBOX_API_KEY)';
    if (error.code === 'restart_cooldown') return `${error.message}(服务端冷却中)`;
    if (error.code === 'restart_failed') return '重启命令执行失败,请查看服务端日志';
    if (error.code === 'pm2_not_found') return '服务端找不到 pm2,无法重启(检查 PM2_BIN)';
    if (error.code === 'auth_locked' || error.code === 'rate_limited') return `${error.message}(稍后再试)`;
    return error.message;
  }
  return `请求失败:${(error as Error).message}`;
}

// ---------------------------------------------------------------- 步骤一:读取当前状态
/**
 * 点「重启 DSH…」:先用密钥读一次当前地址。
 * 这一步既是**验证密钥**(密钥错就没有必要进入确认流程),也是记录"重启前的 token 前缀"。
 */
async function prepare(): Promise<void> {
  if (running) return;
  const key = keyInput.value.trim();
  if (key === '') {
    setStatus('请输入访问密钥', 'err');
    keyInput.focus();
    return;
  }

  prepareButton.disabled = true;
  setStatus('正在读取当前状态…');
  try {
    const info = await callApi<DshLoginUrl>('/api/dsh/login-url', { apiKey: key });
    pendingKey = key; // 仅内存暂存,供确认后使用
    previousPreview = info.tokenPreview;
    infoText.textContent =
      `当前 token 前缀 ${info.tokenPreview}… · 当前状态:${info.valid ? '有效' : '已失效'} · 来源 ${info.source}`;
    infoCard.hidden = false;
    confirmCard.hidden = false;
    resultCard.hidden = true;
    stepsBox.replaceChildren();
    progressCard.hidden = true;
    setStatus('已读取当前状态,请确认是否重启', 'ok');
  } catch (error) {
    // 密钥错误等:清掉暂存,要求重新输入
    pendingKey = '';
    infoCard.hidden = true;
    confirmCard.hidden = true;
    setStatus(describe(error), 'err');
  } finally {
    // 用后即清:输入框不残留密钥(本次流程已把它存进内存变量)
    keyInput.value = '';
    keyInput.disabled = false;
    prepareButton.disabled = false;
  }
}

// ---------------------------------------------------------------- 步骤二:轮询新地址
/**
 * 重启后轮询登录地址,直到 token 变了且校验通过。
 *
 * ⚠️ 为什么间隔是 2 秒、超时 45 秒(实测数据):
 *   dsh 进程启动到把 token 打印进日志,实测需要 **约 8.6 秒**。而
 *   `/api/dsh/login-url` 是需要密钥的接口,走独立的鉴权限流 —— 轮询太快会
 *   把额度烧光,反而在 token 出现的那一刻被 429 挡住(曾经就踩过这个坑:
 *   1.2 秒一次,5 次额度在 5.5 秒耗尽,token 却在 8.6 秒才出现 → 必然超时)。
 *   所以:间隔放宽到 2 秒,额度足够覆盖整个启动期;总超时放到 45 秒留足余量。
 */
async function pollNewUrl(): Promise<DshLoginUrl | null> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    try {
      const info = await callApi<DshLoginUrl>('/api/dsh/login-url', { apiKey: pendingKey });
      if (info.tokenPreview !== previousPreview && info.valid) return info;
    } catch (error) {
      // 重启期间接口会短暂 502/503(进程还没起来、token 还没打印)—— 继续等。
      // 但限流类错误不能按普通间隔重试,否则会把额度空转干净:退避更久。
      if (error instanceof ApiError
        && (error.code === 'rate_limited' || error.code === 'auth_locked')) {
        await sleep(RATE_LIMIT_BACKOFF_MS);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- 步骤三:确认并重启
async function confirmRestart(): Promise<void> {
  if (running) return;
  if (pendingKey === '') {
    setStatus('密钥已失效,请重新输入', 'err');
    return;
  }

  running = true;
  confirmCard.hidden = true;
  progressCard.hidden = false;
  stepsBox.replaceChildren();
  resultCard.hidden = true;
  setStatus('正在重启…');

  try {
    addStep('发送重启命令…', 'doing');
    const result = await callApi<DshRestartResult>('/api/dsh/restart', {
      method: 'POST',
      apiKey: pendingKey,
    });
    finishLastStep(`重启命令已执行(耗时 ${result.tookMs} ms)`, 'done');

    addStep('等待 dsh 重新启动并生成新令牌(约 10 秒)…', 'doing');
    const info = await pollNewUrl();
    if (info === null) {
      finishLastStep(`超时:${POLL_TIMEOUT_MS / 1000} 秒内没取到新地址`, 'warn');
      setStatus('重启已发出,但暂时取不到新地址;稍后可到「DSH 登录地址」工具再取', 'err');
      return;
    }

    finishLastStep('已取到新地址', 'done');
    newUrl = info;
    revealed = false;
    resultCard.hidden = false;
    renderResult();
    setStatus('重启完成,请用下面的新地址打开 dsh', 'ok');
  } catch (error) {
    finishLastStep(describe(error), 'warn');
    setStatus(describe(error), 'err');
  } finally {
    // 关键:流程结束就丢弃密钥
    pendingKey = '';
    running = false;
    keyInput.value = '';
    keyInput.focus();
  }
}

// ---------------------------------------------------------------- 事件绑定
prepareButton.addEventListener('click', () => void prepare());
confirmButton.addEventListener('click', () => void confirmRestart());
keyInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void prepare();
});

must('#cancel').addEventListener('click', () => {
  // 取消 = 放弃这次流程,连内存里的密钥一起丢掉
  pendingKey = '';
  previousPreview = '';
  confirmCard.hidden = true;
  infoCard.hidden = true;
  keyInput.value = '';
  keyInput.focus();
  setStatus('已取消,未执行重启', '');
});

revealButton.addEventListener('click', () => {
  revealed = !revealed;
  renderResult();
});

must('#copy').addEventListener('click', () => {
  if (newUrl === null) return;
  void copyText(newUrl.url).then((ok) => toast(ok ? '已复制(注意保密)' : '复制失败,请手动选择'));
});

must('#open').addEventListener('click', () => {
  if (newUrl === null) return;
  window.open(newUrl.url, '_blank', 'noopener,noreferrer');
});

// ---------------------------------------------------------------- 初始状态
setStatus('先输入访问密钥,再点「重启 DSH…」(会有二次确认)', '');
keyInput.focus();
