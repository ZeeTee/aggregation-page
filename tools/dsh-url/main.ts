/**
 * DSH 登录地址工具。
 *
 * 流程:点按钮 → 带 X-Api-Key 调 /api/dsh/login-url → 展示(默认打码)地址。
 * 密钥存在 localStorage,只在请求头里发送,绝不放进 URL。
 */

import '../../src/shared/base.css';
import './style.css';

import { ApiError, callApi } from '../../src/shared/api';
import { copyText } from '../../src/shared/clipboard';
import { must } from '../../src/shared/dom';
import { toast } from '../../src/shared/toast';
import type { DshLoginUrl } from '../../src/shared/types';

const STORAGE_KEY = 'toolbox.apiKey';

const keyRow = must('#keyRow');
const keyInput = must<HTMLInputElement>('#keyInput');
const fetchButton = must<HTMLButtonElement>('#fetch');
const changeKeyButton = must<HTMLButtonElement>('#changeKey');
const status = must('#status');
const resultCard = must('#resultCard');
const urlText = must('#urlText');
const revealButton = must<HTMLButtonElement>('#reveal');
const warn = must('#warn');
const validBadge = must('#validBadge');

let apiKey = localStorage.getItem(STORAGE_KEY) ?? '';
let current: DshLoginUrl | null = null;
let revealed = false;

function setStatus(message: string, kind: 'ok' | 'err' | '' = ''): void {
  status.textContent = message;
  status.className = `status ${kind}`;
}

function maskUrl(url: string): string {
  const index = url.indexOf('token=');
  if (index < 0) return url;
  return `${url.slice(0, index)}token=${'•'.repeat(12)}`;
}

function render(): void {
  if (current === null) return;
  urlText.textContent = revealed ? current.url : maskUrl(current.url);
  revealButton.textContent = revealed ? '隐藏' : '显示完整地址';
  validBadge.textContent = current.valid ? '校验通过' : '已失效';
  must('#meta').textContent =
    `token 前缀 ${current.tokenPreview}… · 校验于 ${new Date(current.checkedAt).toLocaleTimeString()} · ` +
    `来源 ${current.source}`;
  warn.hidden = current.valid;
  warn.textContent = current.valid
    ? ''
    : '该 token 已失效(交换未返回 303):通常是 dsh 重启过。请在服务器执行 pm2 restart dsh 后重新获取。';
}

async function load(): Promise<void> {
  if (apiKey === '') {
    keyRow.hidden = false;
    changeKeyButton.hidden = true;
    keyInput.focus();
    setStatus('请先输入访问密钥', '');
    return;
  }
  fetchButton.disabled = true;
  setStatus('正在获取…', '');
  try {
    current = await callApi<DshLoginUrl>('/api/dsh/login-url', { apiKey });
    revealed = false;
    resultCard.hidden = false;
    changeKeyButton.hidden = false;
    render();
    setStatus(current.valid ? '获取成功' : '地址已失效', current.valid ? 'ok' : 'err');
  } catch (error) {
    resultCard.hidden = true;
    if (error instanceof ApiError) {
      if (error.code === 'unauthorized') {
        // 密钥错误:清掉本地记录,重新要求输入
        apiKey = '';
        localStorage.removeItem(STORAGE_KEY);
        keyRow.hidden = false;
        keyInput.value = '';
        keyInput.focus();
        setStatus('密钥不正确,请重新输入', 'err');
      } else if (error.code === 'api_key_not_configured') {
        setStatus('服务端未配置密钥(.env 里的 TOOLBOX_API_KEY),该接口暂不可用', 'err');
      } else if (error.code === 'auth_locked' || error.code === 'rate_limited') {
        setStatus(`${error.message}(稍后再试)`, 'err');
      } else {
        setStatus(`${error.message}`, 'err');
      }
    } else {
      setStatus(`请求失败:${(error as Error).message}`, 'err');
    }
  } finally {
    fetchButton.disabled = false;
  }
}

function saveKey(): void {
  const value = keyInput.value.trim();
  if (value === '') {
    setStatus('密钥不能为空', 'err');
    return;
  }
  apiKey = value;
  localStorage.setItem(STORAGE_KEY, value);
  keyRow.hidden = true;
  keyInput.value = '';
  void load();
}

fetchButton.addEventListener('click', () => void load());
must('#keySave').addEventListener('click', saveKey);
keyInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') saveKey();
});

changeKeyButton.addEventListener('click', () => {
  apiKey = '';
  localStorage.removeItem(STORAGE_KEY);
  resultCard.hidden = true;
  keyRow.hidden = false;
  keyInput.focus();
  setStatus('请输入新的访问密钥', '');
});

revealButton.addEventListener('click', () => {
  revealed = !revealed;
  render();
});

must('#copy').addEventListener('click', () => {
  if (current === null) return;
  void copyText(current.url).then((ok) => toast(ok ? '已复制(注意保密)' : '复制失败,请手动选择'));
});

must('#open').addEventListener('click', () => {
  if (current === null) return;
  window.open(current.url, '_blank', 'noopener,noreferrer');
});

// 已存过密钥就直接拉一次,省一次点击
if (apiKey !== '') void load();
else {
  keyRow.hidden = false;
  setStatus('首次使用:请输入访问密钥(保存在本机浏览器)', '');
}
