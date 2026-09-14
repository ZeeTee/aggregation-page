#!/usr/bin/env python3
"""构建工具箱静态站点。

用法:
  python3 build.py                     # 按 config.json 构建到 public/
  python3 build.py --out /tmp/preview  # 构建到指定目录
  python3 build.py --quiet             # 静默构建(供脚本/定时任务调用)
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from aggregation_page.site import build  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="构建工具箱站点")
    ap.add_argument("--config", default=None, help="配置文件路径(默认 config.json)")
    ap.add_argument("--out", default=None, help="输出目录(默认取配置里的 output_dir)")
    ap.add_argument("--quiet", action="store_true", help="静默模式")
    args = ap.parse_args(argv)
    try:
        build(args.config, args.out, verbose=not args.quiet)
    except FileNotFoundError as exc:
        print(f"!! {exc}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
