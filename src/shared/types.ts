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

/**
 * GET /api/dsh/login-url 的响应(前后端共用同一份类型)。
 * 该接口需要 X-Api-Key。
 */
export interface DshLoginUrl {
  /** https://<publicHost>/?token=... */
  url: string;
  host: string;
  port: number;
  /** token 前 8 位,供人工核对 */
  tokenPreview: string;
  /** 303 校验是否通过;false 表示 token 已随 dsh 进程重启失效 */
  valid: boolean;
  checkedAt: string;
  /** 命中的日志文件与行号,便于排障 */
  source: string;
}
