/** 安全响应头与限流。站点经 Cloudflare 隧道对公网开放,这些是基本盘。 */

import { timingSafeEqual } from 'node:crypto';
import type { ServerResponse } from 'node:http';

/**
 * 安全响应头。
 *
 * 说明:CSP 里保留了 'unsafe-inline'(script/style),因为迁移期仍有 vanilla 工具
 * 使用内联 <script>/<style>。**全部工具迁移为 TS 后应移除 'unsafe-inline'**
 * (届时脚本样式都是同源的外部文件)。
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
};

export function applySecurityHeaders(res: ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
}

/** 固定窗口限流:每个 key(通常是 IP)在 windowMs 内允许 limit 次。
 *
 * 注意:不使用构造器参数属性(Node 类型剥离不支持,见 server/api.ts 说明)。
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs = 60_000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** 返回 true 表示允许;false 表示已超限。 */
  allow(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (entry === undefined || now >= entry.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      if (this.hits.size > 5000) this.sweep(now);
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  /** 该 key 距离窗口重置还有多少秒(用于 Retry-After)。 */
  retryAfterSeconds(key: string, now = Date.now()): number {
    const entry = this.hits.get(key);
    if (entry === undefined) return 0;
    return Math.max(0, Math.ceil((entry.resetAt - now) / 1000));
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.hits) {
      if (now >= entry.resetAt) this.hits.delete(key);
    }
  }
}

/** 从请求头里取真实客户端 IP(Cloudflare 隧道会带 CF-Connecting-IP)。 */
export function clientIp(headers: Record<string, string | string[] | undefined>, socketAddress?: string): string {
  const cf = headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf !== '') return cf;
  const forwarded = headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof raw === 'string' && raw !== '') return raw.split(',')[0]!.trim();
  return socketAddress ?? 'unknown';
}

/**
 * 共享密钥比较:常量时间,避免通过响应时间逐字节猜密钥。
 *
 * 注意:长度不同会立刻返回 false(会泄漏长度信息,这是常见取舍)——
 * 密钥长度本身不算机密,真正要防的是逐字节试探。
 */
export function apiKeyMatches(provided: string | undefined, expected: string): boolean {
  if (provided === undefined || expected === '') return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.byteLength !== b.byteLength) return false;
  return timingSafeEqual(a, b);
}

/**
 * 全局失败预算:抵御**分布式**爆破。
 *
 * 单 IP 限流挡不住换 IP 的攻击者,所以这里统计**所有来源**的鉴权失败次数:
 * 在 windowMs 内累计失败达到 limit 次,整个接口冷却 cooldownMs。
 * 正常使用时几乎不会触发(自己输错一两次不会锁)。
 */
export class FailureBudget {
  private failures: number[] = [];
  private blockedUntil = 0;
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;

  constructor(limit: number, windowMs = 600_000, cooldownMs = 600_000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.cooldownMs = cooldownMs;
  }

  recordFailure(now = Date.now()): void {
    this.failures.push(now);
    this.prune(now);
    if (this.failures.length >= this.limit) {
      this.blockedUntil = now + this.cooldownMs;
      this.failures = [];
    }
  }

  blocked(now = Date.now()): boolean {
    return now < this.blockedUntil;
  }

  retryAfterSeconds(now = Date.now()): number {
    return Math.max(0, Math.ceil((this.blockedUntil - now) / 1000));
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.failures.length > 0 && this.failures[0]! < cutoff) this.failures.shift();
  }
}
