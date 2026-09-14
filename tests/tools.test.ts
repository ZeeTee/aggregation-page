/**
 * 工具扫描与元数据校验的单元测试。
 *
 * 校验必须"宁可构建失败也不上线坏卡片"，因此这里重点覆盖各种非法 tool.json。
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ToolConfigError, scanTools } from '../src/build/tools.ts';

/** 在临时目录里造一个工具；meta 传字符串表示"写入原始文本"（用于测坏 JSON）。 */
function makeTools(specs: Record<string, { meta: unknown; files?: string[] }>): string {
  const root = mkdtempSync(join(tmpdir(), 'agg-tools-'));
  for (const [slug, spec] of Object.entries(specs)) {
    const dir = join(root, slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'tool.json'),
      typeof spec.meta === 'string' ? spec.meta : JSON.stringify(spec.meta),
      'utf8',
    );
    for (const file of spec.files ?? ['index.html']) {
      writeFileSync(join(dir, file), '<!DOCTYPE html><html><body></body></html>', 'utf8');
    }
  }
  return root;
}

describe('scanTools', () => {
  it('读取元数据并按 order 排序，缺省字段有默认值', () => {
    const root = makeTools({
      beta: { meta: { name: '第二个', order: 20, tags: ['b'] } },
      alpha: { meta: { name: '第一个', order: 10, tags: ['a'], icon: '🕒' } },
    });
    const result = scanTools(root);
    expect(result.tools.map((t) => t.slug)).toEqual(['alpha', 'beta']);
    expect(result.tools[0]?.icon).toBe('🕒');
    expect(result.tools[1]?.icon).toBe('🧰'); // 默认图标
    expect(result.tools[1]?.status).toBe('ready');
    expect(result.tools[0]?.description).toBe('');
  });

  it('区分 TS 工具与 vanilla 工具', () => {
    const root = makeTools({
      'ts-one': { meta: { name: 'TS 工具' }, files: ['index.html', 'main.ts'] },
      'vanilla-one': { meta: { name: 'vanilla 工具' } },
    });
    const result = scanTools(root);
    expect(result.tsTools.map((t) => t.slug)).toEqual(['ts-one']);
    expect(result.legacyTools.map((t) => t.slug)).toEqual(['vanilla-one']);
    expect(result.tsEntries).toHaveLength(1);
    expect(result.tsEntries[0]?.endsWith(join('ts-one', 'index.html'))).toBe(true);
  });

  it('hidden 工具不进门户，但仍在总量里', () => {
    const root = makeTools({
      shown: { meta: { name: '展示' } },
      secret: { meta: { name: '隐藏', hidden: true } },
    });
    const result = scanTools(root);
    expect(result.tools).toHaveLength(2);
    expect(result.visible.map((t) => t.slug)).toEqual(['shown']);
  });

  it('忽略下划线/点开头的目录与无 tool.json 的目录', () => {
    const root = makeTools({ real: { meta: { name: '真工具' } } });
    mkdirSync(join(root, '_draft'), { recursive: true });
    writeFileSync(join(root, '_draft', 'tool.json'), '{"name":"草稿"}', 'utf8');
    mkdirSync(join(root, 'no-meta'), { recursive: true });
    writeFileSync(join(root, 'no-meta', 'index.html'), 'x', 'utf8');
    expect(scanTools(root).tools.map((t) => t.slug)).toEqual(['real']);
  });

  it.each([
    ['缺少 name', '{"description":"x"}', /缺少必填字段 name/],
    ['name 为空', '{"name":"   "}', /缺少必填字段 name/],
    ['JSON 坏掉', '{"name":', /JSON 解析失败/],
    ['顶层不是对象', '[]', /顶层必须是对象/],
    ['tags 类型错', '{"name":"x","tags":"开发"}', /tags 必须是字符串数组/],
    ['order 非整数', '{"name":"x","order":"10"}', /order 必须是整数/],
    ['status 非法', '{"name":"x","status":"done"}', /status 只能是 ready 或 wip/],
  ])('元数据非法时报错：%s', (_title, meta, pattern) => {
    const root = makeTools({ bad: { meta } });
    expect(() => scanTools(root)).toThrow(ToolConfigError);
    expect(() => scanTools(root)).toThrow(pattern);
  });

  it('目录名非 ASCII 时报错', () => {
    const root = makeTools({ 中文目录: { meta: { name: '中文' } } });
    expect(() => scanTools(root)).toThrow(/目录名只能是/);
  });

  it('缺 index.html 时报错', () => {
    const root = makeTools({ nohtml: { meta: { name: '缺页面' }, files: [] } });
    expect(() => scanTools(root)).toThrow(/缺少 index.html/);
  });

  it('vanilla 工具声明 api:true 时报错（需要后端必须用 main.ts）', () => {
    const root = makeTools({ legacy: { meta: { name: 'vanilla', api: true } } });
    expect(() => scanTools(root)).toThrow(/vanilla 工具不能声明 api: true/);
  });

  it('工具目录不存在时报错', () => {
    expect(() => scanTools('/nonexistent-tools-dir-xyz')).toThrow(/工具目录不存在/);
  });
});
