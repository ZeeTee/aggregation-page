/** 健康检查:进程存活 + 工具数量(供探针/冒烟脚本使用)。 */

import type { Route } from '../api.ts';
import type { RouteDeps } from './index.ts';

export function healthRoute(deps: RouteDeps): Route {
  const startedAt = Date.now();
  return {
    method: 'GET',
    path: '/api/health',
    handle: async () => ({
      status: 'ok',
      version: deps.version,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      processUptimeSeconds: Math.round(process.uptime()),
      tools: deps.toolsCount(),
    }),
  };
}
