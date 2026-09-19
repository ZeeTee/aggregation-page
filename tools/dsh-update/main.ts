/**
 * 🤖 DSH 更新 —— 前端逻辑
 * ============================================================================
 * 流程:输入密钥 → 检测版本 → 选目标 → **二次确认** → POST 启动后台任务
 *       → 轮询进度 → 展示新登录地址(默认打码)
 *
 * ⚠️ 两处刻意的设计:
 *
 * 1. **后台任务 + 轮询**:npm 安装要几十秒,远超接口层 10 秒超时,所以 POST 只是
 *    "启动"并立刻返回,进度靠轮询 GET。轮询间隔 4 秒:鉴权接口限流 30 次/分钟,
 *    更新全程约 1~2 分钟,4 秒一次能稳稳放下(曾经因为轮询烧光额度出过故障)。
 *
 * 2. **二次确认 + 回滚**:这是在更新运行中的 harness,坏版本会让 dsh 起不来。
 *    本工具站是独立服务,所以回滚入口在 dsh 挂掉时仍然可用 —— 这是唯一的自救路径。
 *
 * 密钥策略同站内其他工具:只放内存、不持久化、只走 X-Api-Key 头。
 */

import '../../src/shared/base.css';
import './style.css';

import { ApiError, callApi } from '../../src/shared/api';
import { copyText } from '../../src/shared/clipboard';
import { el, fill, must } from '../../src/shared/dom';
import { toast } from '../../src/shared/toast';
import type { DshUpdateJob, DshUpdateStatus } from '../../src/shared/types';

const API = '/api/dsh/update';
/** 轮询间隔。别调小:鉴权接口有限流(见文件头说明)。 */
const POLL_INTERVAL_MS = 4_000;
/** 单次更新最长等多久(安装几十秒 + 重启约 10 秒) */
const POLL_TIMEOUT_MS = 6 * 60_000;

const keyInput = must<HTMLInputElement>('#keyInput');
const checkButton = must<HTMLButtonElement>('#check');
const currentBox = must('#current');
const actionRow = must('#actionRow');
const targetSelect = must<HTMLSelectElement>('#target');
const customInput = must<HTMLInputElement>('#custom');
const updateButton = must<HTMLButtonElement>('#update');
const rollbackButton = must<HTMLButtonElement>('#rollback');
const confirmBox = must('#confirmBox');
const confirmText = must('#confirmText');
const confirmYes = must<HTMLButtonElement>('#confirmYes');
const confirmNo = must<HTMLButtonElement>('#confirmNo');
const statusEl = must('#status');
const progressCard = must('#progress');
const stepsBox = must('#steps');
const resultCard = must('#result');
const resultTitle = must('#resultTitle');
const newUrlBox = must('#newUrl');
const revealButton = must<HTMLButtonElement>('#reveal');
const copyButton = must<HTMLButtonElement>('#copy');
const openButton = must<HTMLButtonElement>('#open');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let busy = false;
/** 暂存的密钥:取消确认时一并丢弃,不留残余 */
let pendingKey = '';
let pendingAction: 'update' | 'rollback' = 'update';
let pendingTarget = '';
let lastStatus: DshUpdateStatus | null = null;
let lastUrl = '';
let revealed = false;

function setStatus(message: string, kind: 'ok' | 'err' | 'warn' | '' = ''): void {
  statusEl.textContent = message;
  statusEl.className = `status ${kind}`.trim();
}

function setBusy(next: boolean): void {
  busy = next;
  checkButton.disabled = next;
  updateButton.disabled = next;
  rollbackButton.disabled = next;
  checkButton.textContent = next ? '处理中…' : '检测新版本';
}

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'unauthorized':
        return '密钥不正确';
      case 'api_key_not_configured':
        return '服务端未配置访问密钥,该工具不可用';
      case 'npm_not_found':
        return '服务端找不到 npm,无法更新(请检查 DSH_NPM_BIN)';
      case 'update_running':
      case 'update_cooldown':
      case 'rate_limited':
      case 'auth_locked':
        return error.message;
      case 'no_rollback_target':
        return '还没有记录到上一版本,无法回滚';
      case 'invalid_target':
      case 'target_required':
      case 'invalid_body':
        return error.message;
      default:
        return error.message;
    }
  }
  return `请求失败:${(error as Error).message}`;
}

/** 展示当前版本 + 各通道版本 + 可回滚目标。 */
function renderStatus(info: DshUpdateStatus): void {
  lastStatus = info;
  const lines: Array<Node | string> = [
    el('p', { class: 'ver-line' }, [
      el('span', { class: 'label', text: '当前版本' }),
      el('b', { text: info.currentVersion !== '' ? info.currentVersion : '(读不到)' }),
    ]),
  ];

  const channels = Object.entries(info.channels);
  if (channels.length > 0) {
    lines.push(el('p', { class: 'ver-line' }, [
      el('span', { class: 'label', text: 'npm 通道' }),
      el('span', {
        text: channels.map(([k, v]) => `${k}=${v}`).join('   '),
      }),
    ]));
  }
  if (info.previousVersion !== null) {
    lines.push(el('p', { class: 'ver-line' }, [
      el('span', { class: 'label', text: '可回滚到' }),
      el('span', { text: info.previousVersion }),
    ]));
  }
  if (info.registryError !== null) {
    lines.push(el('p', { class: 'warn', text: `查询 npm 失败:${info.registryError}` }));
  }
  if (!info.patchAvailable) {
    lines.push(el('p', { class: 'hint', text: '未配置 loopback 补丁脚本,更新后不会自动重打补丁。' }));
  }
  fill(currentBox, lines);
  currentBox.hidden = false;

  // 目标下拉:通道在前(它们是"跟随更新"的常用选择),再列最近版本
  const options: Array<Node | string> = [];
  for (const [name, version] of channels) {
    options.push(el('option', { value: name, text: `${name}(${version})` }));
  }
  for (const version of info.recentVersions) {
    options.push(el('option', { value: version, text: version }));
  }
  fill(targetSelect, options);

  actionRow.hidden = false;
  rollbackButton.hidden = info.previousVersion === null;
  if (info.previousVersion !== null) {
    rollbackButton.textContent = `回滚到 ${info.previousVersion}`;
  }
}

function renderJob(job: DshUpdateJob | null): void {
  if (job === null) return;
  progressCard.hidden = false;
  fill(stepsBox, job.steps.map((step) => el('div', { class: `step ${step.status}` }, [
    el('span', { class: 'dot', text: step.status === 'done' ? '✓' : step.status === 'failed' ? '✗' : '•' }),
    el('span', { class: 'text', text: step.label }),
    ...(step.detail !== undefined && step.detail !== ''
      ? [el('span', { class: 'detail', text: step.detail })]
      : []),
  ])));
}

/** 更新完成后展示新地址(默认打码)。 */
function renderResult(job: DshUpdateJob): void {
  const ok = job.status === 'ok';
  resultCard.hidden = false;
  resultTitle.textContent = ok
    ? `${job.action === 'rollback' ? '回滚' : '更新'}完成:${job.from} → ${job.newVersion ?? '?'}`
    : `${job.action === 'rollback' ? '回滚' : '更新'}失败`;

  if (!ok) {
    fill(newUrlBox, [el('p', { class: 'err', text: job.error ?? '未知错误' })]);
    newUrlBox.hidden = false;
    return;
  }
  if (job.patchReapplied === true) {
    resultCard.append(el('p', { class: 'hint', text: 'loopback 补丁已自动重新打上。' }));
  }

  const url = job.loginUrl?.url ?? '';
  if (url === '') {
    fill(newUrlBox, [el('p', { class: 'hint', text: '没能等到新登录地址,请到「DSH 登录地址」工具再取。' })]);
    newUrlBox.hidden = false;
    return;
  }
  lastUrl = url;
  revealed = false;
  newUrlBox.textContent = maskUrl(url);
  newUrlBox.hidden = false;
}

function maskUrl(url: string): string {
  return url.replace(/token=[^&]+/, 'token=••••');
}

/** 轮询后台任务直到结束。 */
async function pollJob(): Promise<DshUpdateJob | null> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let seen: DshUpdateJob | null = null;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    try {
      const info = await callApi<DshUpdateStatus>(API, { apiKey: pendingKey });
      renderStatus(info);
      if (info.job !== null) {
        seen = info.job;
        renderJob(info.job);
        if (info.job.status !== 'running') return info.job;
      }
    } catch (error) {
      // 限流就多等一会儿,别把额度空转干净;其它错误继续等(本服务与 dsh 无关,不该失败)
      if (error instanceof ApiError
        && (error.code === 'rate_limited' || error.code === 'auth_locked')) {
        await sleep(10_000);
      }
    }
  }
  return seen;
}

async function check(): Promise<void> {
  if (busy) return;
  const apiKey = keyInput.value;
  if (apiKey === '') {
    setStatus('请输入访问密钥', 'err');
    keyInput.focus();
    return;
  }
  pendingKey = apiKey;
  setBusy(true);
  setStatus('正在查询 npm 上的版本…');
  try {
    const info = await callApi<DshUpdateStatus>(API, { apiKey });
    renderStatus(info);
    if (info.job !== null && info.job.status === 'running') {
      setStatus('有一个更新任务正在进行,下面显示它的进度。');
      renderJob(info.job);
      const done = await pollJob();
      if (done !== null) renderResult(done);
    } else if (info.job !== null) {
      renderJob(info.job);
      renderResult(info.job);
      setStatus('');
    } else {
      setStatus('已获取版本信息。选择目标后点「更新并重启」。', 'ok');
    }
  } catch (error) {
    setStatus(`✗ ${describe(error)}`, 'err');
  } finally {
    setBusy(false);
  }
}

/** 主按钮只做"准备",真正执行要再过一次确认。 */
function askConfirm(action: 'update' | 'rollback'): void {
  if (busy) return;
  if (pendingKey === '') {
    setStatus('请先输入密钥并点「检测新版本」', 'err');
    return;
  }
  const custom = customInput.value.trim();
  const target = action === 'rollback'
    ? (lastStatus?.previousVersion ?? '')
    : (custom !== '' ? custom : targetSelect.value);

  if (target === '') {
    setStatus('请选择或填写要更新到的版本', 'err');
    return;
  }
  pendingAction = action;
  pendingTarget = target;
  confirmText.textContent = action === 'rollback'
    ? `将把 DSH 回滚到 ${target} 并重启。当前所有会话会断开。确认继续?`
    : `将把 DSH 更新到 ${target} 并重启。当前所有会话会断开,若新版本有问题可用「回滚」退回。确认继续?`;
  confirmBox.hidden = false;
}

async function runConfirmed(): Promise<void> {
  if (busy) return;
  confirmBox.hidden = true;
  setBusy(true);
  resultCard.hidden = true;
  progressCard.hidden = false;
  stepsBox.replaceChildren();
  setStatus('正在启动任务…');

  try {
    await callApi(API, {
      method: 'POST',
      apiKey: pendingKey,
      body: { action: pendingAction, target: pendingTarget },
    });
    setStatus('任务已启动,正在执行(可能需要 1~2 分钟)…');
    const job = await pollJob();
    if (job === null) {
      setStatus('✗ 等待超时:任务可能仍在后台执行,请稍后重新「检测新版本」查看结果', 'warn');
      return;
    }
    renderResult(job);
    setStatus(job.status === 'ok' ? '完成。' : `✗ ${job.error ?? '执行失败'}`, job.status === 'ok' ? 'ok' : 'err');
  } catch (error) {
    setStatus(`✗ ${describe(error)}`, 'err');
  } finally {
    setBusy(false);
  }
}

checkButton.addEventListener('click', () => void check());
updateButton.addEventListener('click', () => askConfirm('update'));
rollbackButton.addEventListener('click', () => askConfirm('rollback'));
confirmYes.addEventListener('click', () => void runConfirmed());
confirmNo.addEventListener('click', () => {
  // 取消就把暂存的密钥一起丢掉,避免"点过取消还能靠残留状态动手"
  confirmBox.hidden = true;
  pendingKey = '';
  setStatus('已取消。');
});

revealButton.addEventListener('click', () => {
  if (lastUrl === '') return;
  revealed = !revealed;
  newUrlBox.textContent = revealed ? lastUrl : maskUrl(lastUrl);
  revealButton.textContent = revealed ? '隐藏地址' : '显示完整地址';
});
copyButton.addEventListener('click', () => {
  if (lastUrl === '') return;
  // copyText 失败时是 resolve(false) 而不是 reject,要判返回值
  void copyText(lastUrl).then((ok) => toast(ok ? '已复制' : '复制失败'));
});
openButton.addEventListener('click', () => {
  if (lastUrl === '') return;
  window.open(lastUrl, '_blank', 'noopener');
});
keyInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void check();
});

setStatus('输入访问密钥后点「检测新版本」。');
