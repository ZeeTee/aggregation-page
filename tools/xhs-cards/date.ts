/**
 * 日期小工具(纯函数,不碰 DOM)。
 *
 * 单独成文件的原因:`main.ts` 顶层就要取 DOM 元素,单测直接 import 它会炸;
 * 把纯逻辑抽出来才能被 vitest 直接测。
 */

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * 把 Date 转成 `YYYY-MM-DD`,**按本地时区**取年月日。
 *
 * 不能用 `toISOString().slice(0, 10)` —— 那是 UTC。东八区早上 7 点时,
 * UTC 还是前一天 23 点,页面就会默认成"昨天",而日报是按本地日期命名的。
 */
export function localDateString(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}
