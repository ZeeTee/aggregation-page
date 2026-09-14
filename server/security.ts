/** 安全响应头与限流。站点经 Cloudflare 隧道对公网开放,这些是基本盘。 */

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
