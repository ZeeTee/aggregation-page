/** GET /api/tools:返回构建产物里的工具清单(带 mtime 缓存,构建后自动失效)。 */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { ApiError, type Route } from '../api.ts';
import type { RouteDeps } from './index.ts';

interface Cached {
  mtimeMs: number;
  payload: unknown;
}

export function toolsRoute(deps: RouteDeps): Route {
  let cache: Cached | undefined;

  return {
    method: 'GET',
    path: '/api/tools',
    handle: async () => {
      const file = join(deps.distDir, 'tools.json');
      let mtimeMs: number;
      try {
        mtimeMs = (await stat(file)).mtimeMs;
      } catch {
        throw new ApiError(503, 'tools_unavailable', '工具清单不存在,站点可能尚未构建');
      }
      if (cache === undefined || cache.mtimeMs !== mtimeMs) {
        try {
          cache = { mtimeMs, payload: JSON.parse(await readFile(file, 'utf8')) };
        } catch (error) {
          throw new ApiError(500, 'tools_invalid', `工具清单解析失败:${(error as Error).message}`);
        }
      }
      return cache.payload;
    },
  };
}
