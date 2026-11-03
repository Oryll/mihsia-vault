#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
密匣 · 本地密码保险箱 —— 服务端

职责边界（很重要）：
  * 本文件不接触任何明文，也不知道主密码。
  * 浏览器端用 WebCrypto 完成 PBKDF2 + AES-256-GCM 加解密，
    只把密文（一个 JSON 字符串）交给这里落盘。
  * 服务只监听 127.0.0.1，并且每次启动生成一次性访问令牌，
    令牌通过启动参数交给页面；别的网页无法读取你的数据。

只用 Python 标准库，无需 pip 安装任何东西。
"""

from __future__ import annotations

import json
import os
import secrets
import socket
import sys
import threading
import time
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
DATA_DIR = Path(os.environ.get("MIHSIA_DATA_DIR") or (ROOT / "data"))
VAULT_FILE = DATA_DIR / "vault.json"
BACKUP_DIR = DATA_DIR / "backups"

MAX_BODY = 8 * 1024 * 1024  # 8 MB，足够几万条密码
TOKEN = secrets.token_urlsafe(32)
HOST = "127.0.0.1"
DEFAULT_PORT = 8765

_lock = threading.Lock()

# Windows 上隐藏控制台窗口的备用方案（正常用 .vbs 启动即可）
LAUNCHER_VERSION = "1.0.0"


# --------------------------------------------------------------------------
# 事件流（用于「另一个窗口改了数据」时的提示）
# --------------------------------------------------------------------------
class EventBus:
    """极简长轮询事件总线：写操作后把版本号推给所有挂起的 GET /api/events。"""

    def __init__(self) -> None:
        self._cond = threading.Condition()
        self._version = int(time.time() * 1000)

    def bump(self) -> None:
        with self._cond:
            self._version = max(self._version + 1, int(time.time() * 1000))
            self._cond.notify_all()

    def wait(self, since: int, timeout: float = 25.0) -> int:
        with self._cond:
            if self._version <= since:
                self._cond.wait(timeout)
            return self._version


BUS = EventBus()


# --------------------------------------------------------------------------
# 存储层
# --------------------------------------------------------------------------
def _empty_vault() -> dict:
    return {"format": 1, "createdAt": None, "updatedAt": None, "payload": None}


def ensure_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not BACKUP_DIR.exists():
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)


def read_vault() -> dict:
    ensure_dirs()
    if not VAULT_FILE.exists():
        return _empty_vault()
    try:
        text = VAULT_FILE.read_text(encoding="utf-8")
        data = json.loads(text)
        if not isinstance(data, dict) or "payload" not in data:
            raise ValueError("保险箱文件结构异常")
        return data
    except Exception as exc:  # 文件损坏时不能拖累程序启动
        raise ValueError(f"读取保险箱失败：{exc}") from exc


def atomic_write(path: Path, text: str) -> None:
    """先写临时文件再替换，断电/崩溃也不会把保险箱写成半截。"""
    ensure_dirs()
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def write_vault(data: dict) -> None:
    payload = data.get("payload")
    if payload is not None:
        if not isinstance(payload, str):
            raise ValueError("payload 必须是字符串")
        # 明文兜底检查：密文信封一定以 '{"' 开头的 JSON 或 v1: 前缀
        if not payload.startswith("v1:"):
            raise ValueError("拒绝写入：payload 不是 v1 密文信封")
        if len(payload) > MAX_BODY:
            raise ValueError("保险箱过大")
    snapshot = {
        "format": 1,
        "createdAt": data.get("createdAt") or time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "payload": payload,
    }
    atomic_write(VAULT_FILE, json.dumps(snapshot, ensure_ascii=False, indent=2))


def backup_current(tag: str = "auto") -> str | None:
    """每次覆盖前留一份上一版密文，误操作可回滚。"""
    if not VAULT_FILE.exists():
        return None
    stamp = time.strftime("%Y%m%d-%H%M%S")
    target = BACKUP_DIR / f"vault-{stamp}-{tag}.json"
    target.write_text(VAULT_FILE.read_text(encoding="utf-8"), encoding="utf-8")
    backups = sorted(BACKUP_DIR.glob("vault-*.json"))
    for old in backups[:-40]:  # 只留最近 40 份
        try:
            old.unlink()
        except OSError:
            pass
    return target.name


# --------------------------------------------------------------------------
# HTTP 处理
# --------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "Mihsia/" + LAUNCHER_VERSION
    sys_version = ""

    # ---------- 基础工具 ----------
    def log_message(self, fmt: str, *args) -> None:  # 静音，别刷屏
        pass

    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        for key, val in (extra or {}).items():
            self.send_header(key, val)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, code: int, obj) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self._send(code, body, "application/json; charset=utf-8")

    def _error(self, code: int, message: str) -> None:
        self._json(code, {"ok": False, "error": message})

    def _authorized(self) -> bool:
        """令牌可以走请求头或 ?t= 查询参数；校验失败一律 403。"""
        header = self.headers.get("X-Vault-Token", "")
        if header and secrets.compare_digest(header, TOKEN):
            return True
        query = urllib.parse.urlparse(self.path).query
        params = urllib.parse.parse_qs(query)
        token = (params.get("t") or [""])[0]
        return bool(token) and secrets.compare_digest(token, TOKEN)

    def _same_origin(self) -> bool:
        """挡住跨站请求（表单/脚本从别的网页打过来）。"""
        origin = self.headers.get("Origin")
        if not origin:
            return True  # 同源导航请求没有 Origin
        host = self.headers.get("Host", "")
        return origin in {f"http://{host}", f"https://{host}"}

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > MAX_BODY:
            raise ValueError("请求体过大")
        raw = self.rfile.read(length)
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("请求体必须是 JSON 对象")
        return data

    # ---------- 路由 ----------
    def do_GET(self) -> None:  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        try:
            if path in ("/", "/index.html"):
                return self._serve_file(WEB_DIR / "index.html", "text/html; charset=utf-8")
            if path.startswith("/static/"):
                rel = path[len("/static/"):]
                if ".." in rel or rel.startswith(("/", "\\")):
                    return self._error(400, "非法路径")
                return self._serve_file(WEB_DIR / rel)
            if path == "/favicon.ico":
                return self._send(204, b"", "image/x-icon")
            if path == "/api/health":
                return self._json(200, {"ok": True, "version": LAUNCHER_VERSION})
            if not self._authorized():
                return self._error(403, "访问令牌无效，请重新双击启动脚本")
            if path == "/api/vault":
                return self._json(200, {"ok": True, "vault": read_vault(),
                                        "dataDir": str(DATA_DIR)})
            if path == "/api/events":
                query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                since = int((query.get("since") or ["0"])[0] or 0)
                version = BUS.wait(since)
                return self._json(200, {"ok": True, "version": version})
            return self._error(404, "没有这个接口")
        except ValueError as exc:
            return self._error(400, str(exc))
        except Exception as exc:  # noqa: BLE001
            return self._error(500, f"服务端错误：{exc}")

    def do_POST(self) -> None:  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        try:
            if not self._same_origin():
                return self._error(403, "跨站请求被拒绝")
            if not self._authorized():
                return self._error(403, "访问令牌无效，请重新双击启动脚本")
            if path == "/api/vault":
                data = self._body()
                with _lock:
                    old = read_vault()
                    if old.get("payload") and old.get("payload") != data.get("payload"):
                        backup_current("auto")
                    write_vault(data)
                BUS.bump()
                return self._json(200, {"ok": True, "savedAt": time.time()})
            if path == "/api/import":
                data = self._body()
                with _lock:
                    backup_current("import")
                    write_vault(data)
                BUS.bump()
                return self._json(200, {"ok": True})
            if path == "/api/backup":
                with _lock:
                    name = backup_current("manual")
                return self._json(200, {"ok": True, "name": name})
            if path == "/api/reveal":
                ensure_dirs()
                try:
                    os.startfile(str(DATA_DIR))  # noqa: S606 - 仅在本机打开自己的数据目录
                except AttributeError:  # 非 Windows
                    return self._error(400, "此功能只在 Windows 上可用")
                return self._json(200, {"ok": True, "path": str(DATA_DIR)})
            if path == "/api/shutdown":
                self._json(200, {"ok": True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return None
            return self._error(404, "没有这个接口")
        except ValueError as exc:
            return self._error(400, str(exc))
        except Exception as exc:  # noqa: BLE001
            return self._error(500, f"服务端错误：{exc}")

    def _serve_file(self, path: Path, ctype: str | None = None) -> None:
        if not path.is_file():
            return self._error(404, "文件不存在")
        if ctype is None:
            ctype = {
                ".html": "text/html; charset=utf-8",
                ".css": "text/css; charset=utf-8",
                ".js": "application/javascript; charset=utf-8",
                ".svg": "image/svg+xml",
                ".png": "image/png",
                ".woff2": "font/woff2",
                ".json": "application/json; charset=utf-8",
            }.get(path.suffix.lower(), "application/octet-stream")
        body = path.read_bytes()
        extra = {}
        if path.name == "index.html":
            # 把令牌注入页面，前端 fetch 时带上；同时收紧 CSP
            extra["Content-Security-Policy"] = (
                "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
                "script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; "
                "frame-ancestors 'none'"
            )
            body = body.replace(b"__VAULT_TOKEN__", TOKEN.encode("utf-8"))
        self._send(200, body, ctype, extra)


# --------------------------------------------------------------------------
# 启动
# --------------------------------------------------------------------------
def pick_port(preferred: int = DEFAULT_PORT) -> int:
    for port in [preferred, 0]:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind((HOST, port))
                return sock.getsockname()[1]
            except OSError:
                continue
    raise SystemExit("找不到可用端口")


def is_ours(port: int) -> bool:
    """端口上跑的是不是本程序（只看本机回环，不碰外网）。

    用途：用户双击了两次启动脚本时，第二个实例不该再开一个进程去抢同一个
    vault.json（两个进程同时写会互相覆盖），而应该直接把浏览器指向已有的那个。
    """
    try:
        with socket.create_connection((HOST, port), timeout=0.8) as sock:
            sock.sendall(b"GET /api/health HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")
            data = sock.recv(512)
    except OSError:
        return False
    return b"Mihsia" in data


def main() -> None:
    ensure_dirs()
    port_arg = None
    for arg in sys.argv[1:]:
        if arg.isdigit():
            port_arg = int(arg)

    # 已经在运行了？把浏览器指过去就行。两个进程同时写 vault.json 会互相覆盖。
    # 只在没指定端口时探默认端口——显式指定端口的场合（测试）允许并存。
    if is_ours(port_arg or DEFAULT_PORT):
        running = port_arg or DEFAULT_PORT
        print("密匣已经在运行：http://%s:%d/" % (HOST, running))
        if "--no-browser" not in sys.argv:
            webbrowser.open("http://%s:%d/" % (HOST, running))
        return

    port = port_arg or pick_port()
    try:
        httpd = ThreadingHTTPServer((HOST, port), Handler)
    except OSError as exc:
        raise SystemExit(f"端口 {port} 被占用：{exc}")
    httpd.daemon_threads = True
    url = f"http://{HOST}:{port}/?t={TOKEN}"

    print("=" * 56)
    print("  密匣 · 本地密码保险箱")
    print(f"  地址：http://{HOST}:{port}/")
    print(f"  数据：{VAULT_FILE}")
    print("  这个窗口不要关；关掉就等于锁上保险箱。")
    print("=" * 56)

    if "--no-browser" not in sys.argv:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已关闭。数据都在 data/vault.json 里。")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
