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

/**
 * POST /api/dsh/restart 的响应(前后端共用同一份类型)。
 * ⚠️ 该接口有副作用(会重启 dsh、断开所有会话),需要 X-Api-Key,且有冷却时间。
 */
export interface DshRestartResult {
  restarted: true;
  /** pm2 应用名,通常为 dsh */
  appName: string;
  /** 执行 pm2 restart 命令耗时(毫秒) */
  tookMs: number;
  /** 触发时间(ISO) */
  at: string;
  /** 给用户看的提示(旧地址已失效等) */
  note: string;
}

/**
 * 手工新闻队列里的一条(对应 ai-news-daily 的 data/manual_queue.json)。
 *
 * 状态不在这里给字符串,而是让前端从 consumedAt / result 自行推断,
 * 避免依赖 Python 侧的中文文案。
 */
export interface ManualNewsEntry {
  id: string;
  url: string;
  title: string;
  summary: string;
  note: string;
  /** 加入时间(本地时间,ISO 无时区) */
  addedAt: string;
  /** 被日报处理的时间;空表示还没处理 */
  consumedAt: string;
  /** 'included'(已并入日报) | 'duplicate'(与已有新闻重复,已跳过) | ''(待用) */
  result: string;
  /** 抓到的正文长度(0 表示没抓到,日报里只依据标题/导语) */
  bodyChars: number;
  /** 是否今天加入的 */
  isToday: boolean;
}

/** GET /api/news/manual 的响应(需要 X-Api-Key)。 */
export interface ManualNewsList {
  /** 服务端认定的"今天"(YYYY-MM-DD),避免前后端时区判断不一致 */
  today: string;
  /** 队列文件路径(只读展示,便于排障) */
  queueFile: string;
  entries: ManualNewsEntry[];
  counts: {
    today: number;
    pending: number;
    duplicate: number;
  };
}

/**
 * POST /api/news/manual 的响应(需要 X-Api-Key,有冷却)。
 *
 * 顺带把刷新后的列表一起返回 —— 前端添加完不必再发一次 GET,
 * 这样一次操作只消耗一个请求额度(鉴权接口限流较严)。
 */
export interface ManualNewsAddResult {
  action: 'added' | 'duplicate' | 'invalid';
  /** 附加说明(如"最近日报已收录过"),可能为空 */
  message: string;
  /** 成功添加时对应的条目 */
  entry: ManualNewsEntry | null;
  list: ManualNewsList;
}
