"""站点构建编排:扫描工具 -> 渲染首页 -> 拷贝工具 -> 落盘 public/。

构建是幂等的:每次都会重建 ``public/``,所以删除/改名工具后不会残留旧页面。
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from . import __version__
from .registry import load_tools, signature
from .render import CSS, render_hub, render_tools_json

DEFAULT_CONFIG = "config.json"
IGNORE_PATTERNS = shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store", "*.log")


def load_config(path: str | Path | None = None) -> tuple[dict, Path]:
    """加载配置,返回 (配置字典, 配置文件的绝对路径)。"""
    cfg_path = Path(path) if path else Path(DEFAULT_CONFIG)
    if not cfg_path.is_absolute():
        cfg_path = (Path.cwd() / cfg_path).resolve()
    if not cfg_path.is_file():
        raise FileNotFoundError(f"配置文件不存在:{cfg_path}")
    config = json.loads(cfg_path.read_text(encoding="utf-8"))
    return config, cfg_path


def build(config_path: str | Path | None = None, out_dir: str | Path | None = None,
          verbose: bool = True) -> dict:
    """执行一次完整构建,返回统计信息。"""
    config, cfg_path = load_config(config_path)
    root = cfg_path.parent
    tools_dir = root / "tools"
    public = Path(out_dir) if out_dir else root / config.get("output_dir", "public")
    if not public.is_absolute():
        public = (root / public).resolve()

    def say(msg: str) -> None:
        if verbose:
            print(msg)

    say(f">> aggregation-page v{__version__} 构建开始")
    say(f"   项目根目录:{root}")
    tools = load_tools(tools_dir, verbose=verbose)

    # 重建 public/(避免残留已删除工具的页面)
    if public.exists():
        shutil.rmtree(public)
    (public / "assets").mkdir(parents=True, exist_ok=True)

    (public / "assets" / "base.css").write_text(CSS.strip() + "\n", encoding="utf-8")

    copied = 0
    for tool in tools:
        dest = public / "tools" / tool.slug
        shutil.copytree(tool.path, dest, ignore=IGNORE_PATTERNS)
        copied += 1
        say(f"   [拷贝] {tool.slug} -> {dest.relative_to(public)}")

    (public / "index.html").write_text(render_hub(tools, config), encoding="utf-8")
    (public / "tools.json").write_text(render_tools_json(tools, config), encoding="utf-8")

    stats = {
        "tools": len(tools),
        "copied": copied,
        "public": str(public),
        "config": str(cfg_path),
        "signature": signature(tools_dir, cfg_path),
    }
    say(f"   首页已生成:{public / 'index.html'}")
    say(f"   工具清单:{public / 'tools.json'}")
    say(f">> 完成:{stats['tools']} 个工具 -> {public}")
    return stats
