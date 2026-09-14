/**
 * DSH 登录地址工具。
 *
 * 密钥策略(按要求):**每次获取都要重新输入,不做任何保存** ——
 * 不写 localStorage / sessionStorage / cookie,请求结束立即清空输入框。
 * 密钥只从输入框读取,并且只通过 `X-Api-Key` 请求头发送,绝不放进 URL。
 */

import '../../src/shared/base.css';
import './style.css';

import { ApiError, callApi } from '../../src/shared/api';
import { copyText } from '../../src/shared/clipboard';
import { must } from '../../src/shared/dom';
import { toast } from '../../src/shared/toast';
import type { DshLoginUrl } from '../../src/shared/types';

const keyInput = must<HTMLInputElement>('#keyInput');
const fetchButton = must<HTMLButtonElement>('#fetch');
const status = must('#status');
const resultCard = must('#resultCard');
const urlText = must('#urlText');
const revealButton = must<HTMLButtonElement>('#reveal');
const warn = must('#warn');
const validBadge = must('#validBadge');
const meta = must('#meta');

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
  meta.textContent =
    `token 前缀 ${current.tokenPreview}… · 校验于 ${new Date(current.checkedAt).toLocaleTimeString()} · ` +
    `来源 ${current.source}`;
  warn.hidden = current.valid;
  warn.textContent = current.valid
    ? ''
    : '该 token 已失效(交换未返回 303):通常是 dsh 重启过。请在服务器执行 pm2 restart dsh 后重新获取。';
}

async function load(): Promise<void> {
  // 只从输入框取值:不读任何本地存储
  const apiKey = keyInput.value.trim();
  if (apiKey === '') {
    setStatus('请输入访问密钥', 'err');
    keyInput.focus();
    return;
  }

  fetchButton.disabled = true;
  keyInput.disabled = true;
  setStatus('正在获取…', '');
  try {
    current = await callApi<DshLoginUrl>('/api/dsh/login-url', { apiKey });
    revealed = false;
    resultCard.hidden = false;
    render();
    setStatus(current.valid ? '获取成功' : '地址已失效', current.valid ? 'ok' : 'err');
  } catch (error) {
    resultCard.hidden = true;
    current = null;
    if (error instanceof ApiError) {
      if (error.code === 'unauthorized') setStatus('密钥不正确', 'err');
      else if (error.code === 'api_key_not_configured') {
        setStatus('服务端未配置密钥(.env 里的 TOOLBOX_API_KEY),该接口暂不可用', 'err');
      } else if (error.code === 'auth_locked' || error.code === 'rate_limited') {
        setStatus(`${error.message}(稍后再试)`, 'err');
      } else {
        setStatus(error.message, 'err');
      }
    } else {
      setStatus(`请求失败:${(error as Error).message}`, 'err');
    }
  } finally {
    // 用后即清:输入框里不残留密钥,下次获取必须重新输入
    keyInput.value = '';
    keyInput.disabled = false;
    fetchButton.disabled = false;
    keyInput.focus();
  }
}

fetchButton.addEventListener('click', () => void load());
keyInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void load();
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

setStatus('每次获取都需输入访问密钥(不会被保存)', '');
keyInput.focus();
