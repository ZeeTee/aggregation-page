/**
 * 扫描 tools/ 目录并把 tool.json 读成类型安全的 ToolMeta 列表。
 *
 * 本文件是纯逻辑（只用 node:fs / node:path），便于单测；构建期与 Vite 插件都调用它。
 *
 * 目录约定（与 Python 版保持兼容）::
 *
 *   tools/<slug>/
 *   ├── tool.json      # 元数据（必需）
 *   ├── index.html     # 页面入口（必需）
 *   └── main.ts        # 可选：存在则走 Vite 编译（TS 工具）；否则整目录原样拷贝（vanilla 工具）
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { ToolMeta } from '../shared/types.ts';

export const META_FILE = 'tool.json';
export const ENTRY_FILE = 'index.html';
export const TS_ENTRY_FILE = 'main.ts';

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SKIP_PREFIX = /^[._]/;
const DEFAULT_ICON = '🧰';
const DEFAULT_ORDER = 100;
const STATUSES = new Set(['ready', 'wip']);

/** tool.json 不合法时抛出；构建失败比线上出现坏卡片好。 */
export class ToolConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolConfigError';
  }
}

export interface ScannedTool extends ToolMeta {
  /** 工具目录绝对路径 */
  dir: string;
  /** main.ts 绝对路径；null 表示 vanilla 工具 */
  tsEntry: string | null;
}

export interface ScanResult {
  /** 全部工具（含 hidden），按 order、name 排序 */
  tools: ScannedTool[];
  /** 门户页展示用（排除 hidden） */
  visible: ScannedTool[];
  /** 走 Vite 编译入口的 TS 工具 */
  tsTools: ScannedTool[];
  /** 原样拷贝的 vanilla 工具 */
  legacyTools: ScannedTool[];
  /** rollup input：只有 TS 工具需要编译（vanilla 工具由插件整目录拷贝） */
  tsEntries: string[];
}

function fail(dir: string, problem: string): never {
  throw new ToolConfigError(`tools/${dir}/${META_FILE}: ${problem}`);
}

function parseMeta(dir: string, slug: string): ToolMeta {
  const metaPath = join(dir, META_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch (error) {
    fail(slug, `JSON 解析失败（${(error as Error).message}）`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail(slug, '顶层必须是对象');
  }
  const obj = raw as Record<string, unknown>;

  const name = obj['name'];
  if (typeof name !== 'string' || name.trim() === '') fail(slug, '缺少必填字段 name');

  const rawTags = obj['tags'] ?? [];
  if (!Array.isArray(rawTags) || rawTags.some((t) => typeof t !== 'string')) {
    fail(slug, 'tags 必须是字符串数组');
  }

  const rawOrder = obj['order'] ?? DEFAULT_ORDER;
  if (typeof rawOrder !== 'number' || !Number.isInteger(rawOrder)) {
    fail(slug, 'order 必须是整数');
  }

  const status = typeof obj['status'] === 'string' ? obj['status'] : 'ready';
  if (!STATUSES.has(status)) fail(slug, `status 只能是 ready 或 wip（收到 ${status}）`);

  const meta: ToolMeta = {
    slug,
    name: name.trim(),
    description: typeof obj['description'] === 'string' ? obj['description'].trim() : '',
    tags: (rawTags as string[]).map((t) => t.trim()).filter((t) => t !== ''),
    icon: typeof obj['icon'] === 'string' && obj['icon'] !== '' ? obj['icon'] : DEFAULT_ICON,
    status: status as ToolMeta['status'],
    order: rawOrder,
  };
  if (obj['api'] === true) meta.api = true;
  if (obj['hidden'] === true) meta.hidden = true;
  return meta;
}

/** 扫描工具目录；任何一个工具的元数据不合法都会抛 ToolConfigError。 */
export function scanTools(toolsDir: string): ScanResult {
  if (!existsSync(toolsDir)) {
    throw new ToolConfigError(`工具目录不存在：${toolsDir}`);
  }

  const tools: ScannedTool[] = [];
  for (const entry of readdirSync(toolsDir).sort()) {
    if (SKIP_PREFIX.test(entry)) continue;
    const dir = join(toolsDir, entry);
    if (!statSync(dir).isDirectory()) continue;

    if (!existsSync(join(dir, META_FILE))) continue; // 无元数据 → 不当作工具
    if (!SLUG_PATTERN.test(entry)) {
      fail(entry, '目录名只能是 1–40 位小写字母/数字/连字符（中文名请写在 name 字段）');
    }
    if (!existsSync(join(dir, ENTRY_FILE))) {
      fail(entry, `缺少 ${ENTRY_FILE}`);
    }

    const meta = parseMeta(dir, entry);
    const tsEntryPath = join(dir, TS_ENTRY_FILE);
    tools.push({ ...meta, dir, tsEntry: existsSync(tsEntryPath) ? tsEntryPath : null });
  }

  tools.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'zh-Hans-CN'));

  const tsTools = tools.filter((t) => t.tsEntry !== null);
  const legacyTools = tools.filter((t) => t.tsEntry === null);
  if (legacyTools.some((t) => t.api)) {
    const bad = legacyTools.filter((t) => t.api).map((t) => t.slug).join('、');
    throw new ToolConfigError(`vanilla 工具不能声明 api: true（需要后端请改用 main.ts）：${bad}`);
  }

  return {
    tools,
    visible: tools.filter((t) => !t.hidden),
    tsTools,
    legacyTools,
    tsEntries: tsTools.map((t) => join(t.dir, ENTRY_FILE)),
  };
}

/** 生成 /tools.json（机器可读清单，前后端都可消费）。 */
export function toToolsJson(result: ScanResult, site: { title: string; baseUrl: string }): string {
  const payload = {
    site: site.title,
    base_url: site.baseUrl,
    count: result.visible.length,
    tools: result.visible.map((t) => ({
      slug: t.slug,
      name: t.name,
      description: t.description,
      tags: t.tags,
      icon: t.icon,
      status: t.status,
      api: t.api === true,
      url: `/tools/${t.slug}/`,
    })),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}
