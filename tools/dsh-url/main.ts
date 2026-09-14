/**
 * 🔑 DSH 登录地址工具 —— 前端逻辑
 * ============================================================================
 * 这个页面做的事很少,但每一步都有原因,写在最前面避免以后看不懂:
 *
 *     输入密钥 → 调 GET /api/dsh/login-url → 展示(默认打码)/ 复制 / 打开
 *
 * 三条硬性约定(**改代码前先读**,都是有意为之,不是遗漏):
 *
 *   1. 密钥不保存 —— 不写 localStorage / sessionStorage / cookie,请求结束立刻清空输入框。
 *      这是明确要求。想"顺手加个记住密钥"?先问过再说。
 *   2. 密钥只走请求头 `X-Api-Key` —— 放进 URL 会被 Referer、浏览器历史、服务端访问日志记下来。
 *   3. token 默认打码 —— 这个地址里的 token 等同于 root 级入口,页面默认只露前 8 位。
 *
 * 与 index.html 的契约:下列 id 必须存在(must() 找不到会直接抛错,而不是静默失效):
 *   #keyInput #fetch #status #resultCard #urlText #reveal #copy #open #warn #validBadge #meta
 *
 * 页面状态其实只有三个:
 *   current  最近一次成功获取到的结果(null = 还没获取过,或出错后已清空)
 *   revealed 是否展开完整 token(false = 打码)
 *   输入框    每次请求结束都会清空,所以它**不是**可复用的状态,每次都要重新输入
 */

import '../../src/shared/base.css';
import './style.css';

import { ApiError, callApi } from '../../src/shared/api';
import { copyText } from '../../src/shared/clipboard';
import { must } from '../../src/shared/dom';
import { toast } from '../../src/shared/toast';
import type { DshLoginUrl } from '../../src/shared/types';

// ---------------------------------------------------------------- DOM 引用
// 一次性取好并复用;must() 在元素缺失时抛错,等于把"HTML 与 TS 不同步"变成启动即失败。
const keyInput = must<HTMLInputElement>('#keyInput');   // 密钥输入框(常显,用后清空)
const fetchButton = must<HTMLButtonElement>('#fetch');  // 主按钮:获取地址
const status = must('#status');                         // 状态文案(成功/失败都写这里)
const resultCard = must('#resultCard');                  // 结果卡片(默认隐藏)
const urlText = must('#urlText');                        // 地址文本(打码或完整)
const revealButton = must<HTMLButtonElement>('#reveal'); // 显示/隐藏完整地址
const warn = must('#warn');                              // token 失效时的红字提示
const validBadge = must('#validBadge');                  // 「校验通过 / 已失效」角标
const meta = must('#meta');                              // 前缀、校验时间、来源行号

// ---------------------------------------------------------------- 状态
let current: DshLoginUrl | null = null;
let revealed = false;

// ---------------------------------------------------------------- 小工具

/** 写状态文案。kind 只影响颜色(ok=绿 / err=红 / 空=普通)。 */
function setStatus(message: string, kind: 'ok' | 'err' | '' = ''): void {
  status.textContent = message;
  status.className = `status ${kind}`;
}

/**
 * 把地址里的 token 打码。
 * 只替换 token 的值(保留 `?token=` 前面的部分),这样用户能一眼看出域名对不对。
 */
function maskUrl(url: string): string {
  const index = url.indexOf('token=');
  if (index < 0) return url; // 万一格式变了,宁可原样显示也不要显示成半截
  return `${url.slice(0, index)}token=${'•'.repeat(12)}`;
}

/** 按当前状态重绘结果区(打码/展开、角标、来源信息、失效提示)。 */
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

// ---------------------------------------------------------------- 主流程

/**
 * 获取地址。
 *
 * 流程:取密钥 → 置灰控件 → 调接口 → 成功渲染 / 失败提示 → **无论成败都清空输入框**。
 * 之所以在 finally 里清空:失败时输入框里的错密钥也没有保留价值,
 * 而且"清空"这个动作必须在所有分支都发生,才能保证"每次都要重输"这条约定。
 *
 * 错误码 → 文案(后端定义见 server/api.ts 与 server/routes/dsh.ts):
 *   401 unauthorized           密钥不正确
 *   503 api_key_not_configured 服务端没配 TOOLBOX_API_KEY
 *   429 auth_locked            失败次数过多,接口被整体冷却
 *   429 rate_limited           本机请求过快(每分钟上限)
 *   503 token_not_found        日志里找不到 token(dsh 没在 pm2 下跑?)
 *   502 validate_failed        本机 3080 连不上,无法校验
 */
async function load(): Promise<void> {
  // 密钥只从输入框现取,不读任何本地存储
  const apiKey = keyInput.value.trim();
  if (apiKey === '') {
    setStatus('请输入访问密钥', 'err');
    keyInput.focus();
    return;
  }

  // 请求期间禁用控件,避免连点产生多次请求(后端也有独立限流,这里是第一道)
  fetchButton.disabled = true;
  keyInput.disabled = true;
  setStatus('正在获取…', '');
  try {
    current = await callApi<DshLoginUrl>('/api/dsh/login-url', { apiKey });
    revealed = false; // 每次新结果都先打码
    resultCard.hidden = false;
    render();
    setStatus(current.valid ? '获取成功' : '地址已失效', current.valid ? 'ok' : 'err');
  } catch (error) {
    // 失败时收起结果区,避免旧的地址停留在页面上被误当成当前有效地址
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

// ---------------------------------------------------------------- 事件绑定

fetchButton.addEventListener('click', () => void load());

// 回车即获取,少一次鼠标移动
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
  // noopener/noreferrer:新标签页拿不到本页引用,也带不走 Referer
  window.open(current.url, '_blank', 'noopener,noreferrer');
});

// ---------------------------------------------------------------- 初始状态
setStatus('每次获取都需输入访问密钥(不会被保存)', '');
keyInput.focus();
