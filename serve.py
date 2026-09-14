#!/usr/bin/env python3
"""工具箱站点的本地静态服务器(带自动重建)。

设计:
  · 只监听 127.0.0.1 —— 公网访问由 Cloudflare 隧道负责,不直接暴露端口。
  · 每次请求前比对 tools/ 与 config.json 的修改时间,有变化就自动重新构建,
    因此改完工具刷新浏览器即可看到最新效果,无需手动 build。
  · 静态文件一律 no-cache,避免隧道/CDN 缓存导致改了看不到。

用法:
  python3 serve.py                     # 127.0.0.1:8080(取 config.json 配置)
  python3 serve.py --port 9000
  python3 serve.py --no-watch          # 关闭自动重建
"""

from __future__ import annotations

import argparse
import functools
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from aggregation_page.registry import signature  # noqa: E402
from aggregation_page.site import build, load_config  # noqa: E402

REBUILD_THROTTLE = 1.0  # 秒:两次自动重建的最小间隔


class Handler(SimpleHTTPRequestHandler):
    """静态文件处理器:请求前按需重建,并禁用缓存。"""

    server_version = "aggregation-page"

    def __init__(self, *args, rebuild=None, **kwargs):
        self._rebuild = rebuild
        super().__init__(*args, **kwargs)

    def do_GET(self):  # noqa: N802 - http.server 接口约定
        if self._rebuild:
            self._rebuild()
        super().do_GET()

    def do_HEAD(self):  # noqa: N802
        if self._rebuild:
            self._rebuild()
        super().do_HEAD()

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):  # noqa: A003 - 统一日志格式
        sys.stderr.write("%s - %s\n" % (self.log_date_time_string(), fmt % args))


def make_rebuilder(config_path: Path, public_dir: Path, watch: bool):
    """返回一个可调用的 rebuild 函数(带节流与小锁)。

    判定依据是 tools/ + config.json 的"指纹"(最新 mtime + 文件数量):
    指纹变了就重建,因此新增、修改、删除工具都能立刻反映到站点上。
    """
    state = {"last": 0.0, "sig": None}
    lock = threading.Lock()
    tools_dir = config_path.parent / "tools"

    def rebuild(force: bool = False) -> None:
        if not watch and not force:
            return
        now = time.time()
        if now - state["last"] < REBUILD_THROTTLE:
            return
        with lock:
            if now - state["last"] < REBUILD_THROTTLE:
                return
            state["last"] = now
            sig = signature(tools_dir, config_path)
            if not force and sig == state["sig"]:
                return
            try:
                build(config_path, public_dir, verbose=False)
                state["sig"] = signature(tools_dir, config_path)
                print(f"[rebuild] {time.strftime('%H:%M:%S')} 检测到改动,已重新构建")
            except Exception as exc:  # noqa: BLE001 - 构建失败不应让服务挂掉
                print(f"[rebuild] 构建失败:{exc}")

    rebuild(force=True)  # 启动时先构建一次
    return rebuild


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="工具箱站点本地服务器")
    ap.add_argument("--config", default="config.json", help="配置文件路径")
    ap.add_argument("--host", default=None, help="监听地址(默认取配置)")
    ap.add_argument("--port", type=int, default=None, help="监听端口(默认取配置)")
    ap.add_argument("--out", default=None, help="站点目录(默认取配置的 output_dir)")
    ap.add_argument("--no-watch", action="store_true", help="关闭自动重建")
    args = ap.parse_args(argv)

    config_path = Path(args.config).resolve()
    config, _ = load_config(config_path)
    server_cfg = config.get("server", {})
    host = args.host or server_cfg.get("host", "127.0.0.1")
    port = int(args.port or server_cfg.get("port", 8080))
    public_dir = Path(args.out) if args.out else config_path.parent / config.get(
        "output_dir", "public")
    if not public_dir.is_absolute():
        public_dir = (config_path.parent / public_dir).resolve()

    rebuild = make_rebuilder(config_path, public_dir, watch=not args.no_watch)
    handler = functools.partial(Handler, directory=str(public_dir), rebuild=rebuild)

    httpd = ThreadingHTTPServer((host, port), handler)
    print(f">> 工具箱已启动: http://{host}:{port}/  (站点目录 {public_dir})")
    print(f"   自动重建:{'开' if not args.no_watch else '关'} | Ctrl+C 退出")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n>> 已停止")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
