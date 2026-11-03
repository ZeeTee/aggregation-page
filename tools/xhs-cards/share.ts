/**
 * 判断能否用系统分享面板把「多张图片」交出去。
 *
 * 为什么需要这个:**手机上解压 zip 很麻烦**,而 Web Share API 弹出的系统面板
 * 在 iOS / Android 上都有「存储图像 / 保存到相册」,这才是手机上"一次存多张"
 * 的正确路径。桌面浏览器基本都没有 share,所以要能判断并回退。
 *
 * 抽成纯函数是为了可单测 —— 判断本身有好几个分支(没 share、没 canShare、
 * canShare 返回 false、canShare 抛异常),在浏览器里逐个构造太费劲。
 */

/** 只取我们要用到的两个成员,方便测试时传假对象 */
export interface ShareCapable {
  share?: unknown;
  canShare?: (data?: ShareData) => boolean;
}

/**
 * `files` 非空、且浏览器支持 share 与 canShare、且 canShare 认这些文件时才为 true。
 *
 * `canShare` 抛异常一律当作不支持 —— 某些旧实现对不认识的字段会直接抛。
 */
export function canShareFiles(nav: ShareCapable, files: readonly unknown[]): boolean {
  if (typeof nav.share !== 'function') return false;
  if (typeof nav.canShare !== 'function') return false;
  if (files.length === 0) return false;
  try {
    return nav.canShare({ files: files as File[] });
  } catch {
    return false;
  }
}
