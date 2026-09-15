/**
 * 路由注册表。
 *
 * 这里**显式**列出所有接口(不用文件系统扫描魔法):
 * 审查时一眼能看全站暴露了哪些后端能力,类型也全程有保障。
 *
 * 新增业务接口的步骤:
 *   1. 在 server/routes/ 下新建 xxx.ts,导出一个返回 Route 的工厂函数
 *   2. 在此处注册(需要凭据的接口标 auth: true;有副作用的接口还要加冷却/前置确认)
 *   3. 在 src/shared/types.ts 里补上请求/响应类型(前后端共用)
 *
 * 当前暴露的接口一览:
 *   GET  /api/health           公开    存活探针
 *   GET  /api/tools            公开    工具清单
 *   POST /api/echo             公开    回显(用于验证各错误分支)
 *   GET  /api/dsh/login-url    🔑      读取 dsh 当前登录地址(含 token)
 *   POST /api/dsh/restart      🔑⚠️    重启 dsh(有副作用,带冷却)
 *   GET  /api/news/manual      🔑      手工新闻队列(ai-news-daily)
 *   POST /api/news/manual      🔑⚠️    添加手工新闻(写入明天日报,带冷却)
 */

import type { Route } from '../api.ts';
import { dshRestartRoute, type DshRestartDeps } from './dsh-restart.ts';
import { dshRoute, type DshRouteDeps } from './dsh.ts';
import { echoRoute } from './echo.ts';
import { healthRoute } from './health.ts';
import { newsRoutes, type NewsDeps } from './news.ts';
import { toolsRoute } from './tools.ts';

export interface RouteDeps {
  version: string;
  distDir: string;
  /** 当前构建产物的工具数量(读 tools.json,带缓存) */
  toolsCount: () => number;
  /** DSH 登录地址接口配置(来自环境变量) */
  dsh: DshRouteDeps;
  /** DSH 重启接口配置(来自环境变量) */
  dshRestart: DshRestartDeps;
  /** 手工新闻队列接口配置(来自环境变量) */
  news: NewsDeps;
}

export function buildRoutes(deps: RouteDeps): Route[] {
  return [
    healthRoute(deps),
    toolsRoute(deps),
    echoRoute(),
    dshRoute(deps.dsh),
    dshRestartRoute(deps.dshRestart),
    ...newsRoutes(deps.news),
  ];
}
