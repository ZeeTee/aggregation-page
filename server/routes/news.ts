/**
 * 手工新闻队列接口 —— 查看「今天添加的新闻」+ 添加新闻链接
 * ============================================================================
 * 这个接口把工具站和另一个项目(ai-news-daily 日报系统)打通:
 *
 *   GET  /api/news/manual   查看队列(默认给前端当天新增的那些)
 *   POST /api/news/manual   添加一条新闻链接
 *
 * 两个接口都需要 X-Api-Key:队列里是内部运维信息,而添加是**写操作**
 * (会改变明天日报的内容)。前端每次都要重新输入密钥。
 *
 * ── 为什么是"调 Python 命令"而不是直接读写 JSON 文件 ──────────────────────
 * 队列的语义(URL 规范化规则、条目 id 的哈希算法、72h 去重记忆判断、
 * included/duplicate 生命周期)全部实现在 ai-news-daily 的 Python 代码里。
 * 如果在 TS 侧重写一遍,两条实现迟早会漂移 —— 比如 URL 规范化少去掉一个
 * 追踪参数,就会把本该判为"重复"的链接放行。
 * 所以这里只做一件事:**用 execFile 调它的 CLI,读回 JSON**,保证单一实现。
 *
 * ── 安全约束 ────────────────────────────────────────────────────────────
 *   · 不经 shell(execFile 而非 exec),argv 是数组,不存在命令拼接
 *   · 可执行文件、模块名、选项名全是常量;用户只能提供值
 *   · URL 先做白名单式校验(http/https),选项值用 `--opt=value` 形式传递,
 *     因此即使值以 `-` 开头也不会被 argparse 当成新的选项(参数注入防护)
 *   · 值长度上限 + 控制字符剔除;执行有超时上限
 *
 * ── 为什么把 fetch 超时压到 5 秒 ────────────────────────────────────────
 * server/api.ts 对所有 /api 请求有一条统一的 10 秒超时。抓网页必须留足余量,
 * 否则慢站点会把整个请求拖成 504。抓不到正文不算失败:条目照样入队,
 * 日报里只依据标题/导语摘要(用户也可以自己补标题与导语)。
 *
 * 错误码:
 *   401 unauthorized            密钥不对(server/api.ts)
 *   503 api_key_not_configured  服务端未配置密钥
 *   503 python_not_found        找不到 python3(路径配置错误)
 *   429 add_cooldown            添加太频繁(带 Retry-After)
 *   400 invalid_body / invalid_url / invalid_field
 *   502 news_command_failed     Python 命令失败(详情只进日志)
 *   504 timeout                 执行超时
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

import type {
  ManualNewsAddResult,
  ManualNewsEntry,
  ManualNewsList,
} from '../../src/shared/types.ts';
import { ApiError, type Route } from '../api.ts';
import type { Logger } from '../log.ts';

/** 调用的 Python 模块(常量,不接受用户输入) */
const PY_MODULE = 'newsdaily.cli.add_news';
/** execFile 硬超时:必须明显小于 api.ts 的 10s 单请求超时 */
const EXEC_TIMEOUT_MS = 9_000;

const MAX_URL = 2_000;
const MAX_TITLE = 300;
const MAX_SUMMARY = 1_000;
const MAX_NOTE = 300;

export interface NewsExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** 是否因超时被杀掉 */
  killed?: boolean;
}

export interface NewsDeps {
  /** python3 可执行文件路径 */
  pythonBin: string;
  /** ai-news-daily 项目目录(作为 cwd) */
  projectDir: string;
  /** 抓取网页的超时秒数 */
  fetchTimeoutSeconds: number;
  /** 两次成功添加之间的最小间隔秒数(0 = 不限制) */
  addCooldownSeconds: number;
  /** 可注入的执行器(测试用):参数为命令行参数数组 */
  run?: (args: string[]) => Promise<NewsExecResult>;
  /** 可注入的时钟(测试用) */
  now?: () => number;
}

/** 默认执行器:execFile,不经 shell,参数为数组。 */
function defaultRun(deps: NewsDeps): (args: string[]) => Promise<NewsExecResult> {
  return (args: string[]) =>
    new Promise<NewsExecResult>((resolve) => {
      execFile(
        deps.pythonBin,
        ['-m', PY_MODULE, '--json', ...args],
        { cwd: deps.projectDir, timeout: EXEC_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          const err = error as (Error & { code?: number | string; killed?: boolean }) | null;
          const killed = err?.killed === true;
          let code = 0;
          if (err) code = typeof err.code === 'number' ? err.code : 1;
          resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), killed });
        },
      );
    });
}

// ── 输入校验 ──────────────────────────────────────────────────────────────

/** 只接受 http/https 链接;并挡掉空白与控制字符。 */
function assertUrl(raw: unknown): string {
  if (typeof raw !== 'string') throw new ApiError(400, 'invalid_url', 'url 必须是字符串');
  const value = raw.trim();
  if (value === '') throw new ApiError(400, 'invalid_url', '请填写新闻链接');
  if (value.length > MAX_URL) throw new ApiError(400, 'invalid_url', `链接过长(上限 ${MAX_URL} 字符)`);
  if (!/^https?:\/\/[^\s]+$/i.test(value)) {
    throw new ApiError(400, 'invalid_url', '链接必须以 http:// 或 https:// 开头');
  }
  return value;
}

/** 清洗可选的文本字段:剔除控制字符并限长。 */
function cleanText(raw: unknown, max: number, field: string): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') throw new ApiError(400, 'invalid_field', `${field} 必须是字符串`);
  // eslint-disable-next-line no-control-regex
  const value = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (value.length > max) throw new ApiError(400, 'invalid_field', `${field} 过长(上限 ${max} 字符)`);
  return value;
}

/** 读取请求体对象。 */
function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError(400, 'invalid_body', '请求体必须是 JSON 对象');
  }
  return body as Record<string, unknown>;
}

// ── Python 输出 → 前端类型 ────────────────────────────────────────────────

interface PythonEntry {
  id?: unknown;
  url?: unknown;
  title?: unknown;
  summary?: unknown;
  note?: unknown;
  added_at?: unknown;
  consumed_at?: unknown;
  result?: unknown;
  body_chars?: unknown;
  is_today?: unknown;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function toEntry(raw: PythonEntry): ManualNewsEntry {
  return {
    id: str(raw.id),
    url: str(raw.url),
    title: str(raw.title),
    summary: str(raw.summary),
    note: str(raw.note),
    addedAt: str(raw.added_at),
    consumedAt: str(raw.consumed_at),
    result: str(raw.result),
    bodyChars: typeof raw.body_chars === 'number' ? raw.body_chars : 0,
    isToday: raw.is_today === true,
  };
}

function toList(payload: { today?: unknown; queue_file?: unknown; entries?: unknown }): ManualNewsList {
  const rawEntries = Array.isArray(payload.entries) ? (payload.entries as PythonEntry[]) : [];
  const entries = rawEntries.map(toEntry);
  return {
    today: str(payload.today),
    queueFile: str(payload.queue_file),
    entries,
    counts: {
      today: entries.filter((e) => e.isToday).length,
      pending: entries.filter((e) => e.result !== 'duplicate' && e.consumedAt === '').length,
      duplicate: entries.filter((e) => e.result === 'duplicate').length,
    },
  };
}

/** 调用 Python 并解析它唯一的那份 JSON 输出。 */
async function invoke(
  run: (args: string[]) => Promise<NewsExecResult>,
  args: string[],
  ctx: { log: Logger },
): Promise<Record<string, unknown>> {
  const result = await run(args);

  if (result.killed === true) {
    throw new ApiError(504, 'timeout', '抓取网页超时,请稍后重试(或先只填标题与导语)');
  }

  const text = result.stdout.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 解析失败:多半是 Python 抛异常(如语法/依赖问题)。详情只进日志。
    ctx.log.error('news command output not json', {
      code: result.code,
      stdout: text.slice(0, 300),
      stderr: result.stderr.slice(0, 500),
    });
    throw new ApiError(502, 'news_command_failed', '新闻服务返回了无法解析的结果,请查看服务端日志');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    ctx.log.error('news command output not object', { stdout: text.slice(0, 300) });
    throw new ApiError(502, 'news_command_failed', '新闻服务返回了意外的结果');
  }
  return parsed as Record<string, unknown>;
}

/**
 * 路由工厂。依赖注入(python 路径、执行器、时钟)让"添加 + 冷却 + 校验"
 * 的逻辑可以离线测试,测试里不会真的去执行 python。
 */
export function newsRoutes(deps: NewsDeps): Route[] {
  const injected = deps.run !== undefined;
  const run = deps.run ?? defaultRun(deps);
  const now = deps.now ?? (() => Date.now());
  const cooldownMs = Math.max(0, deps.addCooldownSeconds) * 1000;
  const fetchTimeout = String(Math.max(1, Math.floor(deps.fetchTimeoutSeconds)));

  /** 上次**成功添加**的时间戳;0 表示本进程内还没添加过 */
  let lastAddAt = 0;

  function assertPythonAvailable(): void {
    if (injected) return; // 注入了执行器(测试)时跳过
    if (!existsSync(deps.pythonBin)) {
      throw new ApiError(503, 'python_not_found',
        '服务端找不到 python3,无法访问新闻队列(请检查 NEWS_PYTHON_BIN 配置)');
    }
  }

  const listRoute: Route = {
    method: 'GET',
    path: '/api/news/manual',
    auth: true,
    handle: async (ctx) => {
      assertPythonAvailable();
      const payload = await invoke(run, ['--list'], ctx);
      return toList(payload);
    },
  };

  const addRoute: Route = {
    method: 'POST',
    path: '/api/news/manual',
    auth: true,
    handle: async (ctx): Promise<ManualNewsAddResult> => {
      // ── 冷却:只限制"成功添加",重复/非法不占用冷却 ──────────────
      if (lastAddAt !== 0) {
        const elapsed = now() - lastAddAt;
        if (elapsed < cooldownMs) {
          const retryAfter = Math.ceil((cooldownMs - elapsed) / 1000);
          throw new ApiError(429, 'add_cooldown', `添加太频繁,请 ${retryAfter} 秒后再试`, retryAfter);
        }
      }

      const body = asRecord(ctx.body);
      const url = assertUrl(body['url']);
      const title = cleanText(body['title'], MAX_TITLE, '标题');
      const summary = cleanText(body['summary'], MAX_SUMMARY, '导语');
      const note = cleanText(body['note'], MAX_NOTE, '备注');

      assertPythonAvailable();

      // 选项一律用 `--opt=value`(单个 argv),值以 `-` 开头也不会被当成选项
      const args = ['--timeout', fetchTimeout, `--title=${title}`, `--summary=${summary}`,
        `--note=${note}`, url];
      const payload = await invoke(run, args, ctx);

      const rawResults = Array.isArray(payload.results)
        ? (payload.results as Array<Record<string, unknown>>)
        : [];
      const first = rawResults[0] ?? {};
      const actionRaw = str(first.action);
      const action: ManualNewsAddResult['action'] =
        actionRaw === 'added' || actionRaw === 'duplicate' || actionRaw === 'invalid'
          ? actionRaw
          : 'invalid';
      const message = str(first.message);

      const list = toList(payload);
      const entry = action === 'added'
        ? (list.entries.find((e) => e.url === url) ?? null)
        : null;

      if (action === 'added') lastAddAt = now();

      ctx.log.info('manual news add', { action, url, ip: ctx.ip, title: title.slice(0, 60) });

      return { action, message, entry, list };
    },
  };

  return [listRoute, addRoute];
}
