/**
 * 路由注册表。
 *
 * 这里**显式**列出所有接口(不用文件系统扫描魔法):
 * 审查时一眼能看全站暴露了哪些后端能力,类型也全程有保障。
 *
 * 新增业务接口的步骤:
 *   1. 在 server/routes/ 下新建 xxx.ts,导出一个返回 Route 的工厂函数
 *   2. 在此处注册
 *   3. 在 src/shared/types.ts 里补上请求/响应类型(前后端共用)
 */

import type { Route } from '../api.ts';
import { echoRoute } from './echo.ts';
import { healthRoute } from './health.ts';
import { toolsRoute } from './tools.ts';

export interface RouteDeps {
  version: string;
  distDir: string;
  /** 当前构建产物的工具数量(读 tools.json,带缓存) */
  toolsCount: () => number;
}

export function buildRoutes(deps: RouteDeps): Route[] {
  return [healthRoute(deps), toolsRoute(deps), echoRoute()];
}
