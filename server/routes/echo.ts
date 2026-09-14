/**
 * POST /api/echo:回显请求体。
 *
 * 存在的意义是**把 API 骨架跑通并被测试覆盖**:JSON 解析、体积上限(413)、
 * 方法校验(405)、超时(504)都能通过它验证。真实的业务接口按同样的形状添加。
 */

import type { Route } from '../api.ts';

export function echoRoute(): Route {
  return {
    method: 'POST',
    path: '/api/echo',
    handle: async (ctx) => ({
      received: ctx.body ?? null,
      ip: ctx.ip,
      at: new Date().toISOString(),
    }),
  };
}
