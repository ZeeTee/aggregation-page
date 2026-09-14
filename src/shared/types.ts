/**
 * 前后端共享类型。
 *
 * ⚠️ 本文件（以及 src/shared/ 下所有文件）会被前端打包，**不得**引用 node 内置模块或服务端密钥。
 */

/** 工具元数据，与 tools/<slug>/tool.json 一一对应。 */
export interface ToolMeta {
  /** 目录名，也是 URL 片段：/tools/<slug>/ */
  slug: string;
  name: string;
  description: string;
  tags: string[];
  icon: string;
  status: 'ready' | 'wip';
  order: number;
  /** 该工具需要后端接口（/api/<slug>/*） */
  api?: boolean;
  /** 不在门户展示，但仍会构建 */
  hidden?: boolean;
}

/** 统一 API 响应信封（P2 服务端与前端共用）。 */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

/** 健康检查响应 */
export interface HealthPayload {
  status: 'ok';
  version: string;
  uptimeSeconds: number;
  tools: number;
}
