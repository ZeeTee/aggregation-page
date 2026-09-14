/** 读取 config.json（沿用 Python 版的写法，便于渐进迁移）。 */

import { readFileSync } from 'node:fs';

export interface SiteConfig {
  title: string;
  subtitle: string;
  description: string;
  baseUrl: string;
  footer: string;
}

export interface BuildConfig {
  site: SiteConfig;
  outputDir: string;
}

const FALLBACK: SiteConfig = {
  title: '在线工具箱',
  subtitle: '',
  description: '',
  baseUrl: '',
  footer: '',
};

export function loadBuildConfig(configPath: string): BuildConfig {
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  const site = (raw['site'] ?? {}) as Record<string, unknown>;
  const str = (key: string, fallback = ''): string =>
    typeof site[key] === 'string' ? (site[key] as string) : fallback;

  return {
    site: {
      title: str('title', FALLBACK.title),
      subtitle: str('subtitle'),
      description: str('description'),
      baseUrl: str('base_url'),
      footer: str('footer'),
    },
    outputDir: typeof raw['output_dir'] === 'string' ? (raw['output_dir'] as string) : 'dist',
  };
}
