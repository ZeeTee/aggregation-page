/** 时间戳 ↔ 日期时间 转换（纯前端，数据不出浏览器）。 */

import '../../src/shared/base.css';
import './style.css';

import { copyText } from '../../src/shared/clipboard';
import { must } from '../../src/shared/dom';
import { toast } from '../../src/shared/toast';

const pad = (n: number): string => String(n).padStart(2, '0');

function formatLocal(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** 相对时间描述（“3 分钟前”“2 小时后”） */
function relative(ms: number): string {
  const diff = Date.now() - ms;
  const abs = Math.abs(diff);
  const units: Array<[number, string]> = [
    [86_400_000, '天'],
    [3_600_000, '小时'],
    [60_000, '分钟'],
    [1_000, '秒'],
  ];
  for (const [size, name] of units) {
    if (abs >= size) return `${Math.floor(abs / size)} ${name}${diff >= 0 ? '前' : '后'}`;
  }
  return '刚刚';
}

const nowOut = must('#now');
const nowParts = must('#nowParts');
const tsIn = must<HTMLInputElement>('#tsIn');
const tsOut = must('#tsOut');
const dtIn = must<HTMLInputElement>('#dtIn');
const dtOut = must('#dtOut');

function tick(): void {
  const now = new Date();
  nowOut.textContent = formatLocal(now);
  nowParts.textContent =
    `秒 ${Math.floor(now.getTime() / 1000)} · 毫秒 ${now.getTime()} · UTC ${now.toISOString()}`;
}

document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((button) => {
  button.addEventListener('click', () => {
    const now = new Date();
    const kind = button.dataset['copy'];
    const value =
      kind === 'sec'
        ? String(Math.floor(now.getTime() / 1000))
        : kind === 'ms'
          ? String(now.getTime())
          : now.toISOString();
    void copyText(value).then((ok) => toast(ok ? '已复制' : '复制失败，请手动选择'));
  });
});

must('#tsGo').addEventListener('click', () => {
  const raw = tsIn.value.trim();
  if (!/^-?\d+$/.test(raw)) {
    toast('请输入纯数字时间戳');
    return;
  }
  const isMilliseconds = raw.replace('-', '').length >= 12;
  const value = Number(raw);
  const ms = isMilliseconds ? value : value * 1000;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    toast('时间戳超出可解析范围');
    return;
  }
  tsOut.hidden = false;
  tsOut.innerHTML =
    `识别为<b>${isMilliseconds ? '毫秒' : '秒'}</b>级时间戳<br>` +
    `本地时间：<b>${formatLocal(date)}</b><br>` +
    `UTC：<b>${date.toISOString()}</b><br>` +
    `相对现在：<b>${relative(ms)}</b>`;
});

must('#dtGo').addEventListener('click', () => {
  if (dtIn.value === '') {
    toast('请先选择日期时间');
    return;
  }
  const date = new Date(dtIn.value);
  if (Number.isNaN(date.getTime())) {
    toast('无法解析该时间');
    return;
  }
  dtOut.hidden = false;
  dtOut.innerHTML =
    `秒级时间戳：<b>${Math.floor(date.getTime() / 1000)}</b><br>` +
    `毫秒时间戳：<b>${date.getTime()}</b><br>` +
    `UTC：<b>${date.toISOString()}</b>`;
});

// 默认填入当前时间，方便直接换算
{
  const now = new Date();
  dtIn.value =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

tick();
setInterval(tick, 1000);
